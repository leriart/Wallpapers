#!/usr/bin/env python3
"""Generate docs/index.json + docs/thumbs/* for the GitHub Pages gallery.

Thumbnails are generated locally (no third-party proxy at runtime):
  - images: Pillow resize to 480px, JPEG q75
  - videos: ffmpeg first-frame extract, then Pillow resize

Run from repo root: python3 generate_gallery_index.py
"""

import json
import os
import subprocess
import sys
from pathlib import Path

from wallpaper_tags import tag_wallpapers


CLIP_TAGS_FILE = "docs/vision_tags.json"


def _merge_clip_tags(categories):
    """Merge visual-recognition tags (docs/vision_tags.json) into the index.

    The file maps "cat/name" -> {"series": [...], "characters": [...]}.
    Produced by tag_wallpapers_gemini.py (free Google Gemini API pass);
    merged here so regenerating the index never drops the vision tags.
    """
    p = REPO_ROOT / CLIP_TAGS_FILE
    if not p.exists():
        return
    try:
        clip = json.loads(p.read_text(encoding="utf-8"))
    except Exception:
        return
    for c in categories:
        for f in c["files"]:
            extra = clip.get(f"{c['name']}/{f['name']}")
            if not extra:
                continue
            t = f.setdefault("tags", {"series": [], "characters": [], "tags": []})
            for key in ("series", "characters", "tags"):
                cur = set(t.get(key, []))
                cur.update(extra.get(key, []))
                t[key] = sorted(cur)

REPO_ROOT = Path(__file__).resolve().parent
OUT = REPO_ROOT / "docs" / "index.json"
THUMBS_DIR = REPO_ROOT / "docs" / "thumbs"

IMAGE_EXTENSIONS = {".jpg", ".jpeg", ".png", ".webp", ".gif", ".bmp", ".avif"}
VIDEO_EXTENSIONS = {".mp4", ".webm", ".mov", ".mkv"}

SKIP_TOKENS = {"Render", "Art", "Fi", "Sci", "3d", "2d", "V2", "V3"}


def character_from_name(name: str) -> str:
    parts = name.rsplit(".", 1)[0].split("_")
    if len(parts) < 3:
        return ""
    seg2 = parts[1]
    if seg2[:1].isupper() and seg2 not in SKIP_TOKENS and not seg2.isupper():
        if len(parts) > 2 and parts[2][:1].isupper():
            return f"{seg2} {parts[2]}"
        return seg2
    return ""


def make_thumb(src: Path, dst: Path, is_video: bool) -> bool:
    if dst.exists():
        return True
    dst.parent.mkdir(parents=True, exist_ok=True)
    tmp = dst.with_suffix(".tmp.jpg")
    try:
        if is_video:
            r = subprocess.run(
                ["ffmpeg", "-y", "-loglevel", "error", "-i", str(src),
                 "-frames:v", "1", "-vf", "scale=480:-2", str(tmp)],
                capture_output=True, timeout=60,
            )
            if r.returncode != 0 or not tmp.exists():
                return False
        else:
            from PIL import Image
            im = Image.open(src).convert("RGB")
            im.thumbnail((480, 480))
            im.save(tmp, "JPEG", quality=75)
        os.replace(tmp, dst)
        return True
    except Exception:
        try:
            if tmp.exists():
                tmp.unlink()
        except OSError:
            pass
        return False


def main():
    categories = []
    total_media = 0
    thumbs_ok = 0
    thumbs_fail = 0

    for folder in sorted(REPO_ROOT.iterdir()):
        if not folder.is_dir() or folder.name.startswith(".") or folder.name == "docs":
            continue
        files = []
        for f in sorted(folder.iterdir()):
            if not f.is_file() or f.name.startswith("."):
                continue
            ext = f.suffix.lower()
            if ext in IMAGE_EXTENSIONS:
                kind = "image"
            elif ext in VIDEO_EXTENSIONS:
                kind = "video"
            else:
                continue
            total_media += 1
            thumb_rel = f"thumbs/{folder.name}/{f.stem}.jpg"
            if make_thumb(f, REPO_ROOT / "docs" / thumb_rel, kind == "video"):
                thumbs_ok += 1
            else:
                thumbs_fail += 1
            files.append({
                "name": f.name,
                "kind": kind,
                "size": f.stat().st_size,
                "thumb": thumb_rel,
                "tags": tag_wallpapers(folder.name, f.name),
            })
        files.sort(key=lambda x: x["name"].lower())
        categories.append({"name": folder.name, "files": files})

    OUT.parent.mkdir(exist_ok=True)
    _merge_clip_tags(categories)
    OUT.write_text(json.dumps({
        "repo": "leriart/Wallpapers",
        "branch": "main",
        "categories": categories,
    }), encoding="utf-8")

    # Clean orphan thumbnails (files that no longer exist in the repo)
    valid_thumbs = set()
    for c in categories:
        for f in c["files"]:
            valid_thumbs.add((REPO_ROOT / "docs" / f["thumb"]).resolve())
    removed = 0
    for p in THUMBS_DIR.rglob("*.jpg"):
        if p.resolve() not in valid_thumbs:
            try:
                p.unlink()
                removed += 1
            except OSError:
                pass
    # remove empty dirs
    for d in sorted(THUMBS_DIR.rglob("*"), reverse=True):
        try:
            if d.is_dir() and not any(d.iterdir()):
                d.rmdir()
        except OSError:
            pass

    total = sum(len(c["files"]) for c in categories)
    videos = sum(1 for c in categories for f in c["files"] if f["kind"] == "video")
    print(f"index.json: {len(categories)} categorías, {total} archivos ({videos} videos)")
    print(f"thumbs OK: {thumbs_ok} | fallos: {thumbs_fail} | huérfanos eliminados: {removed}")
    print(f"index.json: {OUT.stat().st_size/1024:.0f} KB | thumbs dir: "
          f"{sum(p.stat().st_size for p in THUMBS_DIR.rglob('*.jpg'))/1024/1024:.0f} MB")


if __name__ == "__main__":
    sys.exit(main())
