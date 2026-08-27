#!/usr/bin/env python3
"""fetch_booru_nsfw.py — NSFW uncensored wallpapers from open boorus.

Sources (anonymous, no keys):
  - yande.re  (moebooru API — anime focused)
  - xbooru    (danbooru-style dapi)

Filters:
  - tag: uncensored, rating explicit/questionable
  - EXCLUDES AI-generated images (ai-generated / ai_generated / sd / mj ...)
  - EXCLUDES male / furry / loli / shota / guro / tentacle / futanari ...
  - shape: square (~1:1) or panoramic (≥ 16:9)  — no portrait
  - sorted by score (popular), deduplicated by md5 against NSFW/

Usage:
    python3 fetch_booru_nsfw.py --dry-run
    python3 fetch_booru_nsfw.py --per-source 10
"""

from __future__ import annotations

import argparse
import hashlib
import html
import json
import re
import time
import urllib.parse
import urllib.request
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent
OUT_DIR = REPO_ROOT / "NSFW"
UA = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36"

SQUARE_RATIO = (0.9, 1.1)
PANORAMIC_MIN = 1.78
RECENT_DAYS = 365
ALLOWED_EXT = {".jpg", ".jpeg", ".png", ".webp"}

# Content that must never be downloaded
EXCLUDE_TAGS = {
    "male", "1boy", "2boys", "3boys", "multiple_boys", "furry", "yaoi",
    "shotacon", "shota", "loli", "lolicon", "trap", "crossdressing", "feral",
    "guro", "scat", "bestiality", "monster_girl", "tentacle", "futanari",
    "male_focus", "pregnant", "diaper", "vore", "cub", "young", "child",
    "boys", "male_penis", "penis", "dick", "cock", "hetero",
    "vaginal", "vaginal_sex", "male_pov", "blowjob", "fellatio",
    "handjob", "cum_in_mouth", "creampie",
}
# AI-generated content (discarded)
AI_TAGS = {
    "ai-generated", "ai_generated", "ai_generation", "ai", "ai_art",
    "ai_artwork", "ai-assisted", "stable_diffusion", "sd", "midjourney",
    "niji", "dalle", "dall-e", "novelai", "anime_diffusion", "machine_learning",
    "artificial_intelligence", "ai_assisted", "generative_ai", "flux",
    "comfyui", "automatic1111", "sdxl", "naifu",
}

SOURCES = {
    "yandere": {
        "url": "https://yande.re/post.json",
        "params": lambda page, top: {"tags": "uncensored order:score" if top else "uncensored",
                                   "limit": 100, "page": page},
        "recent": True,
        "pages": 6,
        "top_pages": 14,
    },
    "konachan": {
        "url": "https://konachan.com/post.json",
        "params": lambda page, top: {"tags": "uncensored order:score" if top else "uncensored",
                                     "limit": 100, "page": page},
        "recent": True,
        "pages": 4,
        "top_pages": 12,
    },
    "xbooru": {
        "url": "https://xbooru.com/index.php",
        "params": lambda page, top: {"page": "dapi", "s": "post", "q": "index",
                                    "tags": "uncensored", "limit": 100,
                                    "pid": page - 1, "json": 1},
        "recent": False,
        "pages": 4,
        "top_pages": 6,
    },
    "tbib": {
        "url": "https://tbib.org/index.php",
        "params": lambda page, top: {"page": "dapi", "s": "post", "q": "index",
                                    "tags": "uncensored", "limit": 100,
                                    "pid": page - 1, "json": 1},
        "recent": False,
        "pages": 4,
        "top_pages": 6,
    },
}


def api_get(url: str, params: dict) -> list:
    full = url + "?" + urllib.parse.urlencode(params)
    req = urllib.request.Request(full, headers={"User-Agent": UA})
    with urllib.request.urlopen(req, timeout=60) as r:
        return json.loads(r.read().decode("utf-8"))


def sanitize_tags(tags: str, limit: int = 8) -> str:
    keep = []
    for t in html.unescape(tags).split():
        if t.startswith("rating:") or t in ("uncensored", "censored", "tagme"):
            continue
        if re.fullmatch(r"[a-z0-9_()\-:']+", t) and len(t) <= 40:
            keep.append(t)
        if len(keep) >= limit:
            break
    return "_".join(keep)[:120]


def md5_of(path: Path) -> str:
    h = hashlib.md5()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--per-source", type=int, default=10)
    ap.add_argument("--dry-run", action="store_true")
    ap.add_argument("--top-rated", action="store_true",
                    help="best-rated all-time (order:score) instead of recent")
    ap.add_argument("--min-ratio", type=float, default=0,
                    help="minimum width/height (0 = all orientations incl. phone; 1.78 = 16:9+)")
    ap.add_argument("--total", type=int, default=0, help="global cap after merging sources")
    args = ap.parse_args()

    existing_md5 = {md5_of(p) for p in OUT_DIR.iterdir()
                    if p.is_file() and p.suffix.lower() in ALLOWED_EXT}
    print(f"NSFW/ ya tiene {len(existing_md5)} archivos (dedupe por md5)")
    print(f"modo: {'TOP-RATED (order:score)' if args.top_rated else 'recientes'} | min-ratio: {args.min_ratio}")

    all_cands = []
    cutoff = time.time() - RECENT_DAYS * 86400
    seen_ids = set()

    for name, src in SOURCES.items():
        print(f"\n=== {name} ===", flush=True)
        posts = []
        pages = src["top_pages"] if args.top_rated else src["pages"]
        for page in range(1, pages + 1):
            try:
                batch = api_get(src["url"], src["params"](page, args.top_rated))
            except Exception as e:
                print(f"  página {page}: error {e}", flush=True)
                break
            if not batch:
                break
            if src["recent"] and not args.top_rated:
                batch = [p for p in batch if p.get("created_at", 0) >= cutoff]
            fresh = [p for p in batch if p["id"] not in seen_ids]
            for p in fresh:
                seen_ids.add(p["id"])
            posts.extend(fresh)
            print(f"  página {page}: +{len(fresh)} (total {len(posts)})", flush=True)
            if len(fresh) < 95 and not args.top_rated:
                break
            time.sleep(1.2)

        cands = []
        for p in posts:
            tags_raw = html.unescape(p.get("tags", ""))
            tags = set(tags_raw.split())
            if tags & EXCLUDE_TAGS or tags & AI_TAGS:
                continue
            if p.get("rating") not in ("e", "q", "explicit", "questionable"):
                continue
            w, h = p.get("width", 0), p.get("height", 0)
            if not w or not h:
                continue
            r = w / h
            if SQUARE_RATIO[0] <= r <= SQUARE_RATIO[1]:
                shape = "square"
            elif r >= args.min_ratio:
                shape = "panoramic"
            else:
                continue
            url = p.get("file_url", "")
            ext = "." + url.rsplit(".", 1)[-1].lower() if "." in url else ""
            if ext not in ALLOWED_EXT:
                continue
            cands.append((p.get("score", 0), shape, p))

        cands.sort(key=lambda x: -x[0])
        print(f"  candidatos: {len(cands)}")
        for score, shape, p in cands[:args.per_source]:
            print(f"    [{shape:9}] score {score:4} {p['width']}x{p['height']}  "
                  f"tags: {' '.join(html.unescape(p['tags']).split()[:8])}")
        all_cands.extend(cands[:args.per_source])

    # merge sources: dedupe by post id, sort by score, cap
    seen_posts = set()
    merged = []
    for score, shape, p in all_cands:
        if p["id"] in seen_posts:
            continue
        seen_posts.add(p["id"])
        merged.append((score, shape, p))
    merged.sort(key=lambda x: -x[0])
    if args.total:
        merged = merged[:args.total]
    print(f"\ntotal tras unir fuentes: {len(merged)} (objetivo: {args.total or 'sin límite'})")

    if args.dry_run:
        return

    for score, shape, p in merged:
            url = p.get("file_url")
            if not url:
                continue
            ext = "." + url.rsplit(".", 1)[-1].lower()
            if ext not in ALLOWED_EXT:
                continue
            # fast skip: the API reports the file hash — no need to download
            api_md5 = p.get("md5") or p.get("hash")
            if api_md5 and api_md5 in existing_md5:
                print(f"  ⏭  id {p['id']}: duplicado (md5 reportado por API)", flush=True)
                continue
            # download to temp to check md5 + avoid partial files on disk
            tmp = OUT_DIR / f".tmp_{p['id']}{ext}"
            ok = False
            for attempt in range(1, 4):
                try:
                    req = urllib.request.Request(url, headers={"User-Agent": UA})
                    with urllib.request.urlopen(req, timeout=300) as r, open(tmp, "wb") as f:
                        f.write(r.read())
                    ok = True
                    break
                except Exception as e:
                    print(f"  ⚠ id {p['id']} intento {attempt}/3: {e}", flush=True)
                    time.sleep(5 * attempt)
            if not ok:
                print(f"  ✗ id {p['id']}: no se pudo descargar", flush=True)
                tmp.unlink(missing_ok=True)
                continue
            h = md5_of(tmp)
            if h in existing_md5:
                tmp.unlink()
                print(f"  ⏭  id {p['id']}: duplicado (md5 ya en NSFW/)", flush=True)
                continue
            existing_md5.add(h)
            base = "NSFW_" + sanitize_tags(p.get("tags", ""))
            dst = OUT_DIR / f"{base}{ext}"
            i = 1
            while dst.exists():
                dst = OUT_DIR / f"{base}_{i}{ext}"
                i += 1
            tmp.rename(dst)
            print(f"  ✓ {dst.name}  ({dst.stat().st_size // 1024} KB)", flush=True)
            time.sleep(1.0)


if __name__ == "__main__":
    main()
