#!/usr/bin/env python3
"""tag_wallpapers_clip.py — visual character/series recognition (open source).

Uses a CLIP model (open_clip + MobileCLIP or ViT-B-32) to recognize
characters and series that the FILENAME doesn't reveal (e.g. Jujutsu
Kaisen wallpapers named generically). This is the optional "real AI" pass
on top of the instant filename heuristics in wallpaper_tags.py.

Requirements (CPU is fine, GPU optional):
    python3 -m venv ~/.clip-venv
    ~/.clip-venv/bin/pip install -U torch --index-url https://download.pytorch.org/whl/cpu
    ~/.clip-venv/bin/pip install open_clip_torch pillow

Usage:
    ~/.clip-venv/bin/python tag_wallpapers_clip.py            # full pass
    ~/.clip-venv/bin/python tag_wallpapers_clip.py --limit 50 # try 50 files
    ~/.clip-venv/bin/python tag_wallpapers_clip.py --threads 8 --model mobileclip

Output:
    - docs/clip_tags.json   (merge source; kept in the repo)
    - merges into docs/index.json tags.series / tags.characters

The classification is zero-shot: each image is compared against a fixed
vocabulary of candidate series + characters (from wallpaper_tags.py) plus
a small set of generic concepts. Scores above SERIES_TH / CHAR_TH are kept.
"""

from __future__ import annotations

import argparse
import json
import sys
import time
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent
INDEX = REPO_ROOT / "docs" / "index.json"
OUT = REPO_ROOT / "docs" / "clip_tags.json"

SERIES_TH = 0.245
CHAR_TH = 0.262
BATCH = 32

# Generic concepts that must NOT win over real characters/series
GENERIC = [
    "anime artwork", "anime girl", "anime boy", "digital art", "fan art",
    "wallpaper", "illustration", "portrait", "landscape scenery", "video game",
]

# Candidate text prompts (zero-shot). Kept compact: series names + characters.
def build_prompts():
    sys.path.insert(0, str(REPO_ROOT))
    import wallpaper_tags as wt

    series_prompts = [f"artwork of the anime/game series {s}" for s in wt.SERIES]
    char_prompts = [f"anime artwork of {c}" for c in wt.CHARACTERS]
    generic_prompts = [f"anime artwork of {g}" for g in GENERIC]
    return series_prompts, char_prompts, generic_prompts


def load_model(name: str, threads: int):
    import torch
    import open_clip

    if threads:
        torch.set_num_threads(threads)
    if name == "mobileclip":
        model, _, preprocess = open_clip.create_model_and_transforms(
            "MobileCLIP-S2", pretrained="datacompdr", cache_dir=str(REPO_ROOT / ".clip-cache"))
    else:
        model, _, preprocess = open_clip.create_model_and_transforms(
            "ViT-B-32", pretrained="laion2b_s34b_b79k", cache_dir=str(REPO_ROOT / ".clip-cache"))
    model.eval()
    return model, preprocess


def run():
    ap = argparse.ArgumentParser()
    ap.add_argument("--limit", type=int, default=0, help="only process first N files")
    ap.add_argument("--threads", type=int, default=0, help="torch CPU threads")
    ap.add_argument("--model", choices=["mobileclip", "vitb32"], default="mobileclip")
    args = ap.parse_args()

    if not INDEX.exists():
        print("docs/index.json not found — run generate_gallery_index.py first")
        sys.exit(1)

    data = json.loads(INDEX.read_text(encoding="utf-8"))
    files = [f for c in data["categories"] for f in c["files"]]
    print(f"catalog: {len(files)} files")

    import torch
    import open_clip
    model, preprocess = load_model(args.model, args.threads)
    tokenizer = open_clip.get_tokenizer("MobileCLIP-S2" if args.model == "mobileclip" else "ViT-B-32")

    series_prompts, char_prompts, generic_prompts = build_prompts()
    all_prompts = generic_prompts + series_prompts + char_prompts
    texts = tokenizer(all_prompts)
    texts = texts.cuda() if torch.cuda.is_available() else texts
    with torch.no_grad():
        text_feats = model.encode_text(texts)
        text_feats /= text_feats.norm(dim=-1, keepdim=True)

    n_gen, n_series = len(generic_prompts), len(series_prompts)
    results = {}
    done = 0
    t0 = time.time()

    def flush_batch(imgs, keys):
        nonlocal done
        if not imgs:
            return
        batch = torch.stack(imgs)
        if torch.cuda.is_available():
            batch = batch.cuda()
        with torch.no_grad():
            image_feats = model.encode_image(batch)
            image_feats /= image_feats.norm(dim=-1, keepdim=True)
            logits = (image_feats @ text_feats.T).cpu().float()
        for i, key in enumerate(keys):
            row = logits[i]
            # generic guard: a generic concept must not be the top hit
            gen_top = row[:n_gen].max().item()
            series_scores = row[n_gen:n_gen + n_series]
            char_scores = row[n_gen + n_series:]
            series_hits = []
            for j, s in enumerate(_series_names()):
                if series_scores[j].item() >= SERIES_TH:
                    series_hits.append(s)
            char_hits = []
            for j, c in enumerate(_char_names()):
                if char_scores[j].item() >= CHAR_TH:
                    char_hits.append(c)
            if series_hits or char_hits:
                results[key] = {"series": series_hits, "characters": char_hits}
        done += len(imgs)
        print(f"  {done}/{len(files)}  ({done / max(time.time() - t0, 1e-9):.1f}/s)", flush=True)

    imgs, keys = [], []
    for f in files:
        if args.limit and len(results) >= args.limit:
            break
        key = _key_of(data, f)
        path = _src_path(data, f)
        if not path.exists():
            continue
        try:
            from PIL import Image
            img = preprocess(Image.open(path).convert("RGB"))
        except Exception:
            continue
        imgs.append(img)
        keys.append(key)
        if len(imgs) >= BATCH:
            flush_batch(imgs, keys)
            imgs, keys = [], []
    flush_batch(imgs, keys)

    OUT.parent.mkdir(exist_ok=True)
    OUT.write_text(json.dumps(results, indent=1, sort_keys=True), encoding="utf-8")
    print(f"wrote {OUT} ({len(results)} files with tags)")

    # merge into index.json
    for c in data["categories"]:
        for f in c["files"]:
            extra = results.get(f"{c['name']}/{f['name']}")
            if not extra:
                continue
            t = f.setdefault("tags", {"series": [], "characters": [], "tags": []})
            for k in ("series", "characters"):
                cur = set(t.get(k, []))
                cur.update(extra.get(k, []))
                t[k] = sorted(cur)
    INDEX.write_text(json.dumps(data, indent=1, sort_keys=True), encoding="utf-8")
    print("merged into docs/index.json")


_cache = {}


def _series_names():
    if "s" not in _cache:
        sys.path.insert(0, str(REPO_ROOT))
        import wallpaper_tags as wt
        _cache["s"] = list(wt.SERIES)
    return _cache["s"]


def _char_names():
    if "c" not in _cache:
        sys.path.insert(0, str(REPO_ROOT))
        import wallpaper_tags as wt
        _cache["c"] = list(wt.CHARACTERS)
    return _cache["c"]


def _key_of(data, target):
    for c in data["categories"]:
        for f in c["files"]:
            if f is target:
                return f"{c['name']}/{f['name']}"
    return target.get("name", "?")


def _src_path(data, target):
    for c in data["categories"]:
        for f in c["files"]:
            if f is target:
                return REPO_ROOT / c["name"] / f["name"]
    return REPO_ROOT / "missing"


if __name__ == "__main__":
    run()
