#!/usr/bin/env python3
"""classify_new.py — organize wallpapers dropped in Por organizar/.

For every media file in Por organizar/ this script:
  1. Reads visual tags from the free, keyless DeepDanbooru Space.
  2. Picks the best matching category folder (priority-ordered rules).
  3. Skips files that are byte-identical to something already in the repo.
  4. Moves the file to <Category>/<Category>_<name> (repo naming convention).

Runs inside the GitHub Action, so: drop files in Por organizar/ → push →
the pipeline classifies, moves, tags and publishes them automatically.

Local usage:  python3 classify_new.py [--limit N] [--dry-run]
"""

from __future__ import annotations

import argparse
import hashlib
import json
import shutil
import subprocess
import sys
import tempfile
import threading
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent
INBOX = REPO_ROOT / "Por organizar"
SPACE = "hysts/DeepDanbooru"
THRESHOLD = 0.35
WORKERS = 3
SLEEP = 1.2
MAX_TAGS = 14

IMAGE_EXTS = {".jpg", ".jpeg", ".png", ".webp", ".gif", ".bmp", ".avif"}
VIDEO_EXTS = {".mp4", ".webm", ".mov", ".mkv"}

HUMAN_TAGS = {
    "1girl", "1boy", "2girls", "3girls", "4girls", "5girls", "6girls",
    "solo", "multiple_girls", "multiple_boys", "1other", "2others",
    "multiple_others", "male_focus", "female_focus", "anime",
}
PHOTO_TAGS = {"photorealistic", "photo", "photograph", "realistic"}
GAME_TAGS = {"screenshot", "game_cg", "game_ui", "hud", "video_game", "game_cg"}

# category -> tags (any match wins); checked in order for non-human images
RULES = [
    ("Pixel_Art", {"pixel_art", "pixelated", "8bit", "16bit", "pixel", "pixels"}),
    ("Watercolor", {"watercolor", "watercolour", "aquarelle"}),
    ("Manga", {"manga", "comic", "ink", "japanese_text", "text_in_image"}),
    ("Monochrome", {"monochrome", "black_and_white", "greyscale", "grayscale"}),
    ("3D_Render", {"3d", "render", "cgi", "3d_render", "3d_art"}),
    ("Photography", PHOTO_TAGS),
    ("Minimalist", {"minimalist", "minimalism", "minimalistic"}),
    ("Abstract", {"abstract", "geometric", "fluid", "swirl", "gradient", "collage", "colorful"}),
    ("Space", {"outer_space", "space", "planet", "galaxy", "nebula", "astronaut",
               "rocket", "spaceship", "alien", "solar_system", "satellite", "stars"}),
    ("Sci_Fi", {"science_fiction", "cyborg", "android", "dystopian", "futuristic",
                "mecha", "robot", "ufo", "spaceship"}),
    ("Cyberpunk", {"cyberpunk", "cyberpunk_(genre)"}),
    ("Neon", {"neon", "neon_lights", "neon_sign", "glow", "fluorescent"}),
    ("Retro", {"retro", "synthwave", "vaporwave", "outrun", "vintage", "80s", "90s"}),
    ("Cars", {"car", "vehicle", "automobile", "motorcycle", "truck", "bus",
              "sports_car", "racing", "steering_wheel", "convertible"}),
    ("Animals", {"animal", "animal_focus", "dog", "cat", "bird", "wolf", "fox",
                 "horse", "deer", "tiger", "lion", "bear", "rabbit", "panda",
                 "squirrel", "fish", "whale", "dolphin", "butterfly", "snake",
                 "dragon", "bird_focus", "mammal"}),
    ("Nature", {"scenery", "landscape", "mountain", "forest", "ocean", "sea",
                "beach", "lake", "river", "waterfall", "field", "meadow",
                "garden", "desert", "trees", "nature", "flowers", "coast",
                "valley", "hill", "snow", "ice", "volcano", "jungle", "sky",
                "clouds", "sunset", "sunrise", "night", "city", "cityscape",
                "building", "architecture", "bridge", "tower", "street"}),
    ("Fantasy", {"fantasy", "magic", "elf", "knight", "fairy", "witch", "wizard",
                 "medieval", "mythical", "unicorn", "sorcerer", "magician"}),
    ("Dark", {"dark", "dark_theme", "horror", "abandoned", "gloomy", "moody",
              "silhouette", "shadow", "creepy"}),
    ("Pastel", {"pastel", "pastel_colors"}),
    ("Games", GAME_TAGS),
]


def md5_of(path: Path) -> str:
    h = hashlib.md5()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def build_existing_hashes() -> set:
    """md5 of every media file already in the repo (for dedupe)."""
    hashes = set()
    for d in REPO_ROOT.iterdir():
        if not d.is_dir() or d.name.startswith(".") or d.name in ("docs", "Por organizar"):
            continue
        for p in d.iterdir():
            if p.is_file() and p.suffix.lower() in IMAGE_EXTS | VIDEO_EXTS:
                hashes.add(md5_of(p))
    return hashes


def make_thumb(src: Path, tmp: Path) -> Path | None:
    ext = src.suffix.lower()
    try:
        if ext in VIDEO_EXTS:
            r = subprocess.run(
                ["ffmpeg", "-y", "-loglevel", "error", "-i", str(src),
                 "-frames:v", "1", "-vf", "scale=480:-2", str(tmp)],
                capture_output=True, timeout=60)
            return tmp if r.returncode == 0 and tmp.exists() else None
        from PIL import Image
        im = Image.open(src)
        im.thumbnail((480, 480))
        im.convert("RGB").save(tmp, "JPEG", quality=75)
        return tmp
    except Exception:
        return None


def classify_tags(tags: set) -> str:
    """Pick a category from the tag set. Priority-ordered, humans → Anime."""
    if tags & HUMAN_TAGS:
        if tags & PHOTO_TAGS:
            return "Photography"
        if tags & GAME_TAGS:
            return "Games"
        return "Anime"
    for cat, tagset in RULES:
        if tags & tagset:
            return cat
    return "Other"


def target_name(cat: str, name: str) -> str:
    if name.startswith(cat + "_"):
        return name
    return f"{cat}_{name}"


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--limit", type=int, default=0)
    ap.add_argument("--dry-run", action="store_true")
    args = ap.parse_args()

    if not INBOX.is_dir():
        print(f"{INBOX} no existe — nada que clasificar")
        return
    files = [p for p in INBOX.iterdir()
             if p.is_file() and p.suffix.lower() in IMAGE_EXTS | VIDEO_EXTS]
    if not files:
        print("Por organizar/ está vacío — nada que clasificar")
        return
    if args.limit:
        files = files[:args.limit]

    print(f"clasificando {len(files)} archivo(s) de Por organizar/ ...", flush=True)
    existing_hashes = build_existing_hashes()
    print(f"  (índice de duplicados: {len(existing_hashes)} archivos)", flush=True)

    from gradio_client import Client, handle_file
    client = Client(SPACE, verbose=False)
    lock = threading.Lock()
    report = []
    results = {}

    def work(p: Path):
        with tempfile.TemporaryDirectory() as td:
            tmp = Path(td) / "thumb.jpg"
            thumb = make_thumb(p, tmp)
            if thumb is None:
                results[p.name] = ("ERROR", "no se pudo generar thumbnail", "")
                return
            for attempt in range(1, 5):
                try:
                    out = client.predict(handle_file(str(thumb)), THRESHOLD, api_name="/predict")
                    j = out[1] or {}
                    tags = [t for t in j if not t.startswith("rating:")]
                    results[p.name] = ("TAGS", tags[:MAX_TAGS], tags)
                    return
                except Exception:
                    time.sleep(6 * attempt)
            results[p.name] = ("ERROR", "falló la API", "")

    with ThreadPoolExecutor(max_workers=WORKERS) as ex:
        for _ in as_completed([ex.submit(work, p) for p in files]):
            pass

    for p in sorted(files, key=lambda x: x.name):
        status, detail, tags = results.get(p.name, ("ERROR", "sin resultado", ""))
        if status == "ERROR":
            report.append((p, None, None, f"ERROR: {detail}"))
            continue
        tagset = set(tags)
        cat = classify_tags(tagset)
        h = md5_of(p)
        if h in existing_hashes:
            report.append((p, None, None, "DUPLICADO (ya existe en el repo)"))
            continue
        dst = REPO_ROOT / cat / target_name(cat, p.name)
        if dst.exists():
            base = dst.stem
            i = 1
            while (REPO_ROOT / cat / f"{base}_{i}{dst.suffix}").exists():
                i += 1
            dst = REPO_ROOT / cat / f"{base}_{i}{dst.suffix}"
        report.append((p, cat, dst, f"tags: {', '.join(sorted(tagset)[:8]) or '-'}"))

    moved = dupes = errors = 0
    for p, cat, dst, note in report:
        if cat is None:
            if note.startswith("DUPLICADO"):
                dupes += 1
                print(f"  ⏭  {p.name}: {note}", flush=True)
                if not args.dry_run:
                    p.unlink()
            else:
                errors += 1
                print(f"  ✗  {p.name}: {note}", flush=True)
            continue
        print(f"  →  {p.name}: {cat}  ({note})", flush=True)
        if not args.dry_run:
            dst.parent.mkdir(exist_ok=True)
            shutil.move(str(p), str(dst))
            moved += 1

    print(f"\nresumen: {moved} movidos | {dupes} duplicados eliminados | {errors} errores", flush=True)


if __name__ == "__main__":
    main()
