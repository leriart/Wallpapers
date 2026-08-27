#!/usr/bin/env python3
"""tag_wallpapers_online.py — visual tagging via FREE, keyless, online APIs.

No API keys, no local models, no billing. Two stages, both resumable:

  Stage "general" (fast, ~1-2 h):
    hysts/DeepDanbooru Space — danbooru-style GENERAL tags for every image.
  Stage "chars" (slow, ~10-12 h overnight):
    SmilingWolf/wd-tagger Space — CHARACTER + SERIES recognition (the
    precise one, e.g. "2b (nier:automata)").

Results accumulate in docs/vision_tags.json and are merged into
docs/index.json. The static site stays lightweight — it never calls any
API; it only reads the precomputed tags.

Usage:
    python3 tag_wallpapers_online.py --stage general   # fast general tags
    python3 tag_wallpapers_online.py --stage chars     # slow char/series pass
    python3 tag_wallpapers_online.py                   # both, in order
    python3 tag_wallpapers_online.py --stage chars --limit 50
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

SPACE_GENERAL = "hysts/DeepDanbooru"
SPACE_CHARS = "SmilingWolf/wd-tagger"
MODEL_CHARS = "SmilingWolf/wd-swinv2-tagger-v3"

GENERAL_TH = 0.35
CHAR_TH = 0.55
MAX_CHARS = 3
MAX_TAGS = 10
SLEEP = 1.2
MAX_RETRIES = 6
CHECKPOINT_EVERY = 100

CHAR_LABEL_RE = re.compile(r"^(.*?)\s*\(([^)]+)\)$")


def normalize_name(raw: str) -> str:
    s = str(raw).strip().replace("_", " ")
    return " ".join(w.capitalize() for w in s.split())


def normalize_series(raw: str) -> str:
    out = []
    for p in str(raw).split(":"):
        p = p.replace("_", " ")
        out.append(" ".join(w.capitalize() for w in p.split()))
    return ":".join(out)


def parse_character_label(label: str):
    m = CHAR_LABEL_RE.match(str(label))
    if m:
        return normalize_name(m.group(1)), normalize_series(m.group(2))
    return normalize_name(label), None


def load_state():
    if OUT.exists():
        try:
            return json.loads(OUT.read_text(encoding="utf-8"))
        except Exception:
            return {}
    return {}


def save_state(results):
    OUT.parent.mkdir(exist_ok=True)
    OUT.write_text(json.dumps(results, indent=1, sort_keys=True), encoding="utf-8")


def merge_into_index(data, results):
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
    INDEX.write_text(json.dumps(data, indent=1, sort_keys=True), encoding="utf-8")


def stage_general(args, data, results):
    from gradio_client import Client, handle_file

    todo = []
    for c in data["categories"]:
        for f in c["files"]:
            key = f"{c['name']}/{f['name']}"
            if "tags" in results.get(key, {}):
                continue
            tp = REPO_ROOT / "docs" / f["thumb"]
            if tp.exists():
                todo.append((key, tp))
    if args.limit:
        todo = todo[:args.limit]
    print(f"[general] to tag: {len(todo)} | workers: {args.workers}", flush=True)
    if not todo:
        print("[general] nothing to do", flush=True)
        return

    lock = threading.Lock()
    t0, done = time.time(), [0]

    def work(key, tp):
        from gradio_client import Client, handle_file
        client = Client(SPACE_GENERAL, verbose=False)
        for attempt in range(1, MAX_RETRIES + 1):
            try:
                out = client.predict(handle_file(str(tp)), GENERAL_TH, api_name="/predict")
                j = out[1] or {}
                tags = []
                for label, score in j.items():
                    if label.startswith("rating:"):
                        continue
                    tags.append(normalize_name(label))
                    if len(tags) >= MAX_TAGS:
                        break
                with lock:
                    entry = results.setdefault(key, {"series": [], "characters": [], "tags": []})
                    entry["tags"] = sorted(set(entry.get("tags", [])) | set(tags))
                    done[0] += 1
                    if done[0] % CHECKPOINT_EVERY == 0:
                        save_state(results)
                        el = max(time.time() - t0, 1e-9)
                        print(f"[general] {done[0]}/{len(todo)} ({done[0]/el:.1f}/s, "
                              f"ETA {(len(todo)-done[0])/(done[0]/el)/60:.0f} min)", flush=True)
                return
            except Exception as e:  # noqa: BLE001
                time.sleep(min(6 * attempt, 30))
        with lock:
            done[0] += 1
        print(f"[general] FAILED {key}", flush=True)

    with ThreadPoolExecutor(max_workers=args.workers) as ex:
        for _ in as_completed([ex.submit(work, k, tp) for k, tp in todo]):
            pass
    save_state(results)
    print(f"[general] done — {len(results)} entries saved", flush=True)


def stage_chars(args, data, results):
    from gradio_client import Client, handle_file

    todo = []
    skipped_no_humans = 0
    for c in data["categories"]:
        for f in c["files"]:
            key = f"{c['name']}/{f['name']}"
            if "series" in results.get(key, {}):
                continue
            # scenery/no-people files (from the general stage) don't need it
            prev = results.get(key, {})
            if any("no humans" in t.lower() for t in prev.get("tags", [])):
                skipped_no_humans += 1
                continue
            tp = REPO_ROOT / "docs" / f["thumb"]
            if tp.exists():
                todo.append((key, tp))
    if args.limit:
        todo = todo[:args.limit]
    print(f"[chars] to tag: {len(todo)} (skipped {skipped_no_humans} no-human) | "
          f"workers: {args.workers} (~{len(todo)/max(args.workers,1)*15/3600:.1f} h at ~15s/req)", flush=True)
    if not todo:
        print("[chars] nothing to do", flush=True)
        return

    lock = threading.Lock()
    t0, done = time.time(), [0]

    def work(key, tp):
        from gradio_client import Client, handle_file
        client = Client(SPACE_CHARS, verbose=False)
        for attempt in range(1, MAX_RETRIES + 1):
            try:
                out = client.predict(
                    handle_file(str(tp)), MODEL_CHARS, GENERAL_TH, False,
                    CHAR_TH, False, api_name="/predict")
                chars = ((out[2] or {}).get("confidences") or [])
                characters, series = [], []
                for item in chars[:MAX_CHARS]:
                    name, s = parse_character_label(item.get("label", ""))
                    if name and name.lower() not in ("unknown", "none"):
                        characters.append(name)
                        if s and s not in series:
                            series.append(s)
                with lock:
                    entry = results.setdefault(key, {"series": [], "characters": [], "tags": []})
                    entry["series"] = sorted(set(entry.get("series", [])) | set(series))
                    entry["characters"] = sorted(set(entry.get("characters", [])) | set(characters))
                    done[0] += 1
                    if done[0] % CHECKPOINT_EVERY == 0:
                        save_state(results)
                        el = max(time.time() - t0, 1e-9)
                        print(f"[chars] {done[0]}/{len(todo)} ({done[0]/el:.2f}/s, "
                              f"ETA {(len(todo)-done[0])/(done[0]/el)/3600:.1f} h)", flush=True)
                return
            except Exception as e:  # noqa: BLE001
                time.sleep(min(8 * attempt, 40))
        with lock:
            done[0] += 1
        print(f"[chars] FAILED {key}", flush=True)

    with ThreadPoolExecutor(max_workers=args.workers) as ex:
        for _ in as_completed([ex.submit(work, k, tp) for k, tp in todo]):
            pass
    save_state(results)
    print(f"[chars] done — {len(results)} entries saved", flush=True)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--stage", choices=["all", "general", "chars"], default="all")
    ap.add_argument("--workers", type=int, default=3)
    ap.add_argument("--limit", type=int, default=0)
    ap.add_argument("--dry-run", action="store_true")
    args = ap.parse_args()

    data = json.loads(INDEX.read_text(encoding="utf-8"))
    results = load_state()

    total = sum(len(c["files"]) for c in data["categories"])
    print(f"catalog: {total} files | vision_tags entries: {len(results)}", flush=True)
    if args.dry_run:
        return

    if args.stage in ("all", "general"):
        stage_general(args, data, results)
    if args.stage in ("all", "chars"):
        args.workers = max(args.workers, 2)  # chars stage is slow; keep >=2
        stage_chars(args, data, results)

    save_state(results)
    merge_into_index(data, results)
    print("merged into docs/index.json", flush=True)


if __name__ == "__main__":
    main()
