#!/usr/bin/env python3
"""tag_wallpapers_online.py — visual series/character recognition via a FREE,
keyless, online API. No API keys, no local models, no billing.

It calls the public Gradio API of the open-source WD14 tagger Space
(SmilingWolf/wd-tagger — WD-SwinV2 v3, danbooru-style tags) anonymously and
merges the results into docs/vision_tags.json + docs/index.json.

The PAGE stays lightweight: it never calls any API — recognition runs once
on your machine, the static site only reads the tags.

Usage:
    python3 tag_wallpapers_online.py             # full pass, 2 workers
    python3 tag_wallpapers_online.py --limit 50  # try on 50 files first
    python3 tag_wallpapers_online.py --workers 1 # be gentle with the Space
    python3 tag_wallpapers_online.py --dry-run   # show the plan

Resumable: already-tagged files are skipped (docs/vision_tags.json).
"""

from __future__ import annotations

import argparse
import json
import re
import sys
import threading
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent
INDEX = REPO_ROOT / "docs" / "index.json"
OUT = REPO_ROOT / "docs" / "vision_tags.json"

SPACE = "SmilingWolf/wd-tagger"
MODEL = "SmilingWolf/wd-swinv2-tagger-v3"
CHAR_TH = 0.55          # character confidence threshold
GENERAL_TH = 0.35       # general tag confidence threshold
MAX_CHARS = 3
MAX_TAGS = 8
SLEEP = 1.5             # seconds each worker waits between requests
MAX_RETRIES = 5

CHAR_LABEL_RE = re.compile(r"^(.*?)\s*\(([^)]+)\)$")


def normalize_name(raw: str) -> str:
    """'tails_(sonic)' -> 'Tails', 'gojo_satoru' -> 'Gojo Satoru'."""
    s = raw.strip().replace("_", " ")
    s = " ".join(w.capitalize() for w in s.split())
    return s


def normalize_series(raw: str) -> str:
    """'nier:automata' -> 'Nier:Automata', 'jujutsu_kaisen' -> 'Jujutsu Kaisen'."""
    parts = raw.strip().split(":")
    out = []
    for p in parts:
        p = p.replace("_", " ")
        p = " ".join(w.capitalize() for w in p.split())
        out.append(p)
    return ":".join(out)


def parse_character_label(label: str):
    """Returns (name, series|None) from a wd-tagger character label."""
    m = CHAR_LABEL_RE.match(label)
    if m:
        return normalize_name(m.group(1)), normalize_series(m.group(2))
    return normalize_name(label), None


def classify_one(client, thumb_path: Path) -> dict:
    from gradio_client import handle_file

    out = client.predict(
        handle_file(str(thumb_path)),
        MODEL, GENERAL_TH, False, CHAR_TH, False,
        api_name="/predict",
    )
    chars = ((out[2] or {}).get("confidences") or [])
    tags = ((out[3] or {}).get("confidences") or [])

    characters = []
    series = []
    for item in chars[:MAX_CHARS]:
        name, s = parse_character_label(str(item.get("label", "")))
        if name and name.lower() not in ("unknown", "none"):
            characters.append(name)
            if s and s not in series:
                series.append(s)
    general = []
    for item in tags:
        label = str(item.get("label", ""))
        if label.startswith("rating:"):
            continue
        general.append(normalize_name(label))
        if len(general) >= MAX_TAGS:
            break
    return {"series": series, "characters": characters, "tags": general}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--limit", type=int, default=0)
    ap.add_argument("--workers", type=int, default=2)
    ap.add_argument("--dry-run", action="store_true")
    args = ap.parse_args()

    data = json.loads(INDEX.read_text(encoding="utf-8"))
    existing = {}
    if OUT.exists():
        try:
            existing = json.loads(OUT.read_text(encoding="utf-8"))
        except Exception:
            existing = {}

    todo = []
    skipped = 0
    for c in data["categories"]:
        for f in c["files"]:
            key = f"{c['name']}/{f['name']}"
            if key in existing:
                continue
            tp = REPO_ROOT / "docs" / f["thumb"]
            if not tp.exists():
                skipped += 1
                continue
            todo.append((key, tp))
    if args.limit:
        todo = todo[:args.limit]

    print(f"total files: {sum(len(c['files']) for c in data['categories'])} | "
          f"already tagged: {len(existing)} | to tag: {len(todo)} | "
          f"missing thumbs: {skipped} | workers: {args.workers}")
    if args.dry_run or not todo:
        return

    results = dict(existing)
    lock = threading.Lock()
    failures = {}
    t0 = time.time()
    done = [0]

    def work(key, tp):
        from gradio_client import Client
        client = Client(SPACE, verbose=False)
        last_err = None
        for attempt in range(1, MAX_RETRIES + 1):
            try:
                res = classify_one(client, tp)
                with lock:
                    results[key] = res
                    done[0] += 1
                    if done[0] % 100 == 0:
                        OUT.write_text(json.dumps(results, indent=1, sort_keys=True), encoding="utf-8")
                        el = max(time.time() - t0, 1e-9)
                        print(f"  {done[0]}/{len(todo)} tagged ({done[0]/el:.2f}/s, "
                              f"ETA {el/done[0]*(len(todo)-done[0])/60:.0f} min)", flush=True)
                return
            except Exception as e:  # noqa: BLE001 — transient queue/network errors
                last_err = f"{type(e).__name__}: {e}"
                time.sleep(min(8 * attempt, 40))
            time.sleep(SLEEP)
        with lock:
            failures[key] = last_err
            done[0] += 1
        print(f"  FAILED {key}: {last_err}", flush=True)

    with ThreadPoolExecutor(max_workers=args.workers) as ex:
        futs = [ex.submit(work, k, tp) for k, tp in todo]
        for _ in as_completed(futs):
            pass

    OUT.write_text(json.dumps(results, indent=1, sort_keys=True), encoding="utf-8")
    tagged = sum(1 for v in results.values() if v.get("series") or v.get("characters") or v.get("tags"))
    print(f"wrote {OUT} | tagged: {tagged}/{len(results)} | failed: {len(failures)}")

    # merge into index.json
    merged_series = merged_chars = merged_tags = 0
    for c in data["categories"]:
        for f in c["files"]:
            extra = results.get(f"{c['name']}/{f['name']}")
            if not extra:
                continue
            t = f.setdefault("tags", {"series": [], "characters": [], "tags": []})
            for k in ("series", "characters", "tags"):
                cur = set(t.get(k, []))
                cur.update(extra.get(k, []))
                t[k] = sorted(cur)
            merged_series += len(extra.get("series", []))
            merged_chars += len(extra.get("characters", []))
            merged_tags += len(extra.get("tags", []))
    INDEX.write_text(json.dumps(data, indent=1, sort_keys=True), encoding="utf-8")
    print(f"merged into docs/index.json (+{merged_series} series, +{merged_chars} chars, +{merged_tags} tags)")


if __name__ == "__main__":
    main()
