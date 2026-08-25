#!/usr/bin/env python3
"""Generate docs/index.json — gallery index for the GitHub Pages viewer.

Lists every category with its files (name, kind, size, character) so the
front-end can render the gallery without hitting the GitHub API (rate limits).
Run from repo root: python3 generate_gallery_index.py
"""

import json
import os
import re
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent
OUT = REPO_ROOT / "docs" / "index.json"

IMAGE_EXTENSIONS = {".jpg", ".jpeg", ".png", ".webp", ".gif", ".bmp", ".avif"}
VIDEO_EXTENSIONS = {".mp4", ".webm", ".mov", ".mkv"}

SKIP_TOKENS = {"Render", "Art", "Fi", "Sci", "3d", "2d", "V2", "V3"}


def character_from_name(name: str) -> str:
    """Extract character from Clase_Personaje_tag1_tag2.ext (heuristic)."""
    parts = name.rsplit(".", 1)[0].split("_")
    if len(parts) < 3:
        return ""
    seg2 = parts[1]
    if seg2[:1].isupper() and seg2 not in SKIP_TOKENS and not seg2.isupper():
        if len(parts) > 2 and parts[2][:1].isupper():
            return f"{seg2} {parts[2]}"
        return seg2
    return ""


def main():
    categories = []
    for folder in sorted(REPO_ROOT.iterdir()):
        if not folder.is_dir() or folder.name.startswith("."):
            continue
        files = []
        for f in folder.iterdir():
            if not f.is_file() or f.name.startswith("."):
                continue
            ext = f.suffix.lower()
            if ext in IMAGE_EXTENSIONS:
                kind = "image"
            elif ext in VIDEO_EXTENSIONS:
                kind = "video"
            else:
                continue
            files.append({
                "name": f.name,
                "kind": kind,
                "size": f.stat().st_size,
                "char": character_from_name(f.name),
            })
        files.sort(key=lambda x: x["name"].lower())
        categories.append({
            "name": folder.name,
            "files": files,
        })

    OUT.parent.mkdir(exist_ok=True)
    OUT.write_text(json.dumps({"repo": "leriart/Wallpapers", "branch": "main", "categories": categories}),
                   encoding="utf-8")
    total = sum(len(c["files"]) for c in categories)
    videos = sum(1 for c in categories for f in c["files"] if f["kind"] == "video")
    print(f"index.json generado: {len(categories)} categorías, {total} archivos ({videos} videos)")
    print(f"Tamaño: {OUT.stat().st_size/1024:.0f} KB")


if __name__ == "__main__":
    main()
