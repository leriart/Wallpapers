#!/usr/bin/env python3
"""tag_wallpapers_gemini.py — visual character/series recognition via the
FREE Google Gemini API (no local models, page stays lightweight).

The page itself never calls the API: this script runs once (or occasionally)
on your machine, asks Gemini to identify series/characters from the existing
480px thumbnails, and merges the results into docs/index.json. The GitHub
Pages site stays a fast, static, tag-searchable catalog.

Cost: free tier (Google AI Studio API key, no billing needed).
Model: gemini-2.5-flash-lite — 15 RPM / 1,000 requests per day (2026 free
tier). With 8 thumbnails per request the whole catalog (~5,780 files) needs
~720 requests → one ~1h run, well inside the free quota.

Get the key (free):  https://aistudio.google.com/apikey
Then run:
    export GEMINI_API_KEY=...
    python3 tag_wallpapers_gemini.py            # full pass (resumable)
    python3 tag_wallpapers_gemini.py --limit 80 # try on 80 files first
    python3 tag_wallpapers_gemini.py --dry-run  # show plan, do nothing

Output:
    - docs/vision_tags.json  (merge source; committed to the repo)
    - merges into docs/index.json tags.series / tags.characters
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent
INDEX = REPO_ROOT / "docs" / "index.json"
OUT = REPO_ROOT / "docs" / "vision_tags.json"

MODEL = "gemini-2.5-flash-lite"
API = f"https://generativelanguage.googleapis.com/v1beta/models/{MODEL}:generateContent"

BATCH = 8           # thumbnails per request
SLEEP = 5.5         # seconds between requests (≈11 RPM, under the 15 RPM cap)
MAX_RETRIES = 6

PROMPT = """You are a tagging engine for an anime/game wallpaper collection.
I will send you {n} thumbnail images. For EACH one, identify:
- "series": the anime/video game series it belongs to (e.g. "Jujutsu Kaisen", "Sonic", "Fate")
- "characters": the character(s) shown (e.g. "Gojo Satoru", "Tails", "Saber")

Rules:
- If a series or character is not confidently recognizable, use null.
- Prefer the canonical English name. Do NOT invent names.
- If a thumbnail is scenery/abstract/landscape with no characters or series,
  return null for both.
- Answer ONLY with a JSON array, one object per image, in order:
[{{"series": "...", "characters": ["..."]}}, ...]
"""


def load_index():
    data = json.loads(INDEX.read_text(encoding="utf-8"))
    files = []
    for c in data["categories"]:
        for f in c["files"]:
            files.append((f"{c['name']}/{f['name']}", c["name"], f["name"]))
    return data, files


def load_existing():
    if OUT.exists():
        try:
            return json.loads(OUT.read_text(encoding="utf-8"))
        except Exception:
            return {}
    return {}


def thumb_path(data, cat, name) -> Path | None:
    for c in data["categories"]:
        if c["name"] != cat:
            continue
        for f in c["files"]:
            if f["name"] == name:
                return REPO_ROOT / "docs" / f["thumb"]
    return None


def encode_thumb(path: Path) -> str:
    import base64
    return base64.b64encode(path.read_bytes()).decode("ascii")


def call_api(api_key: str, parts: list) -> dict:
    body = {
        "contents": [{"parts": parts}],
        "generationConfig": {
            "temperature": 0.1,
            "maxOutputTokens": 2048,
            "responseMimeType": "application/json",
        },
    }
    req = urllib.request.Request(
        f"{API}?key={api_key}",
        data=json.dumps(body).encode("utf-8"),
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=120) as resp:
        return json.loads(resp.read().decode("utf-8"))


def parse_response(resp: dict) -> list:
    try:
        text = resp["candidates"][0]["content"]["parts"][0]["text"]
    except (KeyError, IndexError):
        return []
    text = text.strip()
    if text.startswith("```"):
        text = text.strip("`")
        if text.startswith("json"):
            text = text[4:]
    try:
        out = json.loads(text)
    except json.JSONDecodeError:
        # try to salvage the array if the model wrapped it in prose
        start, end = text.find("["), text.rfind("]")
        if start == -1 or end == -1:
            return []
        try:
            out = json.loads(text[start:end + 1])
        except json.JSONDecodeError:
            return []
    return out if isinstance(out, list) else []


def normalize(v):
    """Map free-form names onto our tag vocabulary when possible."""
    if not v:
        return None
    s = str(v).strip()
    if not s or s.lower() in ("null", "none", "unknown", "n/a"):
        return None
    return s


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--limit", type=int, default=0, help="only tag first N files")
    ap.add_argument("--dry-run", action="store_true", help="show the plan, don't call the API")
    ap.add_argument("--batch", type=int, default=BATCH)
    args = ap.parse_args()

    api_key = os.environ.get("GEMINI_API_KEY", "").strip()
    if not api_key:
        print("GEMINI_API_KEY not set. Get a free key at https://aistudio.google.com/apikey")
        sys.exit(1)

    data, files = load_index()
    existing = load_existing()
    todo = [(k, c, n) for (k, c, n) in files if k not in existing]
    if args.limit:
        todo = todo[:args.limit]

    n_req = (len(todo) + args.batch - 1) // args.batch
    print(f"total files: {len(files)} | already tagged: {len(files) - len(todo)} | "
          f"to tag: {len(todo)} → ~{n_req} requests (≈{n_req * SLEEP / 60:.0f} min at {SLEEP}s spacing)")

    if args.dry_run:
        return

    results = dict(existing)
    failures = 0

    def flush(batch, out):
        nonlocal failures
        parts = [{"text": PROMPT.format(n=len(batch))}]
        for i, (k, cat, name) in enumerate(batch):
            tp = thumb_path(data, cat, name)
            if not tp or not tp.exists():
                out[k] = {"series": [], "characters": [], "error": "no thumb"}
                continue
            parts.append({"text": f"Image {i}:"})
            parts.append({"inline_data": {"mime_type": "image/jpeg",
                                          "data": encode_thumb(tp)}})

        last_err = None
        for attempt in range(1, MAX_RETRIES + 1):
            try:
                resp = call_api(api_key, parts)
                parsed = parse_response(resp)
                if len(parsed) != len(batch):
                    raise ValueError(f"expected {len(batch)} items, got {len(parsed)}")
                for (k, _, _), item in zip(batch, parsed):
                    series = normalize(item.get("series"))
                    chars = [normalize(c) for c in (item.get("characters") or [])]
                    chars = [c for c in chars if c]
                    if series or chars:
                        out[k] = {"series": [series] if series else [],
                                  "characters": chars}
                    else:
                        out[k] = {"series": [], "characters": []}
                return
            except urllib.error.HTTPError as e:
                last_err = f"HTTP {e.code}"
                if e.code == 429 or e.code >= 500:
                    wait = min(5 * attempt, 30)
                    print(f"  {last_err} — retry in {wait}s", flush=True)
                    time.sleep(wait)
                    continue
                out[batch[0][0]] = {"series": [], "characters": [], "error": last_err}
                failures += 1
                return
            except Exception as e:  # noqa: BLE001 — transient network/json issues
                last_err = str(e)[:120]
                time.sleep(3 * attempt)
                continue
        out[batch[0][0]] = {"series": [], "characters": [], "error": last_err}
        failures += 1

    batch, t0 = [], time.time()
    done = 0
    for item in todo:
        batch.append(item)
        if len(batch) >= args.batch:
            flush(batch, results)
            done += len(batch)
            batch = []
            if done % 200 == 0:
                print(f"  {done}/{len(todo)}  ({done / max(time.time() - t0, 1e-9):.1f}/s)", flush=True)
                OUT.write_text(json.dumps(results, indent=1, sort_keys=True), encoding="utf-8")
            time.sleep(SLEEP)
    if batch:
        flush(batch, results)
        done += len(batch)

    OUT.write_text(json.dumps(results, indent=1, sort_keys=True), encoding="utf-8")
    tagged = sum(1 for v in results.values() if v.get("series") or v.get("characters"))
    print(f"wrote {OUT} | tagged: {tagged}/{len(results)} | failures: {failures}")

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


if __name__ == "__main__":
    main()
