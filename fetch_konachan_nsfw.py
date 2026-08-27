#!/usr/bin/env python3
"""fetch_konachan_nsfw.py — download this month's popular NSFW wallpapers
from Konachan into the hidden NSFW/ folder.

Criteria:
  - tag: uncensored  (Konachan no longer tags "1girl" on new posts — the
    tag exists but its search index is broken; explicit posts are
    overwhelmingly single girls, and we exclude male/furry content)
  - posted within the last N days (default 30)
  - shape: square (~1:1) or panoramic (≥ 2:1)
  - sorted by score → the popular ones
  - excludes: male/furry/loli/shota/guro content, non-JPEG-safe formats

Usage:
    python3 fetch_konachan_nsfw.py --dry-run   # show what would be picked
    python3 fetch_konachan_nsfw.py --limit 12  # download top 12
"""

from __future__ import annotations

import argparse
import json
import re
import time
import urllib.parse
import urllib.request
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent
OUT_DIR = REPO_ROOT / "NSFW"
API = "https://konachan.com/post.json"
UA = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36"

SQUARE_RATIO = (0.9, 1.1)    # near 1:1
PANORAMIC_MIN = 1.78         # 16:9 and wider (portrait excluded)
EXCLUDE_TAGS = {
    "male", "1boy", "2boys", "3boys", "multiple_boys", "furry", "yaoi",
    "shotacon", "shota", "loli", "lolicon", "trap", "crossdressing", "feral",
    "guro", "scat", "bestiality", "monster_girl", "tentacle", "futanari",
    "male_focus", "pregnant", "diaper", "vore", "cub", "young", "child",
}
ALLOWED_EXT = {".jpg", ".jpeg", ".png", ".webp"}


def api_get(params: dict) -> list:
    url = API + "?" + urllib.parse.urlencode(params)
    req = urllib.request.Request(url, headers={"User-Agent": UA})
    with urllib.request.urlopen(req, timeout=60) as r:
        return json.loads(r.read().decode("utf-8"))


def sanitize_tags(tags: str, limit: int = 8) -> str:
    keep = []
    for t in tags.split():
        if t.startswith("rating:") or t in ("uncensored", "censored", "tagme"):
            continue
        if re.fullmatch(r"[a-z0-9_()\-:]+", t) and len(t) <= 40:
            keep.append(t)
        if len(keep) >= limit:
            break
    return "_".join(keep)[:120]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--limit", type=int, default=12, help="how many to download")
    ap.add_argument("--days", type=int, default=30)
    ap.add_argument("--dry-run", action="store_true")
    args = ap.parse_args()

    cutoff = time.time() - args.days * 86400
    print(f"buscando 'uncensored' de los últimos {args.days} días ...", flush=True)

    posts = []
    seen = set()
    for page in range(1, 8):  # up to 700 posts reviewed
        batch = api_get({"tags": "uncensored", "limit": 100, "page": page})
        if not batch:
            break
        fresh = [p for p in batch if p.get("created_at", 0) >= cutoff and p["id"] not in seen]
        for p in fresh:
            seen.add(p["id"])
        posts.extend(fresh)
        print(f"  página {page}: +{len(fresh)} recientes (total {len(posts)})", flush=True)
        if len(fresh) < 90:  # recent window exhausted
            break
        time.sleep(1.2)

    if not posts:
        print("sin posts recientes — revisa la API")
        return

    # shape filter
    def shape(p):
        w, h = p.get("width", 0), p.get("height", 0)
        if not w or not h:
            return None
        r = w / h
        if SQUARE_RATIO[0] <= r <= SQUARE_RATIO[1]:
            return "square"
        if r >= PANORAMIC_MIN:
            return "panoramic"
        return None

    cands = []
    for p in posts:
        tags = set(p.get("tags", "").split())
        if tags & EXCLUDE_TAGS:
            continue
        if p.get("rating") not in ("e", "q"):
            continue
        s = shape(p)
        if not s:
            continue
        ext = "." + (p.get("file_url", "").rsplit(".", 1)[-1] if "." in p.get("file_url", "") else "jpg")
        if ext.lower() not in ALLOWED_EXT:
            continue
        cands.append((p.get("score", 0), s, p))

    cands.sort(key=lambda x: -x[0])
    print(f"\ncandidatos: {len(cands)} (cuadradas + panorámicas, sin contenido excluido)")
    for score, s, p in cands[:args.limit]:
        print(f"  [{s:9}] score {score:5}  {p['width']}x{p['height']}  "
              f"{p.get('file_url','')[-40:]}")

    if args.dry_run:
        return

    print(f"\ndescargando {min(args.limit, len(cands))} ...", flush=True)
    saved = 0
    for score, s, p in cands[:args.limit]:
        url = p.get("file_url") or p.get("sample_url")
        if not url:
            continue
        ext = "." + url.rsplit(".", 1)[-1].lower() if "." in url else ".jpg"
        if ext not in ALLOWED_EXT:
            continue
        base = "NSFW_" + sanitize_tags(p.get("tags", ""))
        dst = OUT_DIR / f"{base}{ext}"
        i = 1
        while dst.exists():
            dst = OUT_DIR / f"{base}_{i}{ext}"
            i += 1
        try:
            req = urllib.request.Request(url, headers={"User-Agent": UA})
            with urllib.request.urlopen(req, timeout=180) as r, open(dst, "wb") as f:
                f.write(r.read())
            print(f"  ✓ {dst.name}  ({dst.stat().st_size // 1024} KB)", flush=True)
            saved += 1
        except Exception as e:
            print(f"  ✗ {url[-50:]}: {e}", flush=True)
        time.sleep(1.0)

    print(f"guardados: {saved} en NSFW/")


if __name__ == "__main__":
    main()
