#!/usr/bin/env python3
"""Generate README.md with scroll-snap image/video carousels from each category folder.

Optimized 2026-08-25:
  - Supports video wallpapers (mp4/webm) alongside images.
  - Proper URL-encoding of filenames (urllib.parse.quote).
  - Skips hidden files in counts (e.g. .category.json).
  - Per-category badges: N files (images + videos).
  - Badge colors for every current category.
  - Mixed carousel: up to 15 samples per category (images + videos).
"""

import random
from pathlib import Path
from urllib.parse import quote

REPO_ROOT = Path(__file__).resolve().parent
IMAGE_EXTENSIONS = {".jpg", ".jpeg", ".png", ".webp", ".gif", ".bmp", ".avif"}
VIDEO_EXTENSIONS = {".mp4", ".webm", ".mov", ".mkv"}

BADGE_COLORS = {
    "3D_Render": "a371f7",
    "Abstract": "79c0ff",
    "Animals": "7ee787",
    "Anime": "f7768e",
    "Cars": "e3b341",
    "Cyberpunk": "7dcfff",
    "Dark": "565f89",
    "Fantasy": "bc8cff",
    "Games": "62b788",
    "Landscape": "7ee787",
    "Manga": "ff9e64",
    "Minimalist": "c0caf5",
    "Monochrome": "8b949e",
    "Nature": "3fb950",
    "Neon": "ff007c",
    "Other": "6e7681",
    "Pastel": "f2cc60",
    "Photography": "58a6ff",
    "Pixel_Art": "e0af68",
    "Portrait": "f778ba",
    "Retro": "d29922",
    "Sci_Fi": "a5d6ff",
    "Space": "7aa2f7",
    "Voxel": "9e6a03",
    "Watercolor": "56d4dd",
}


def discover_categories(root: Path):
    categories = []
    for folder in sorted(root.iterdir()):
        if not folder.is_dir() or folder.name.startswith(".") or folder.name in ("docs", "NSFW", "Por organizar"):
            continue
        files = [
            f.name for f in folder.iterdir()
            if f.is_file() and not f.name.startswith(".")
        ]
        image_files = [f for f in files if Path(f).suffix.lower() in IMAGE_EXTENSIONS]
        video_files = [f for f in files if Path(f).suffix.lower() in VIDEO_EXTENSIONS]
        image_files.sort(key=str.lower)
        video_files.sort(key=str.lower)
        random.seed(folder.name)
        shuffled_images = image_files.copy()
        random.shuffle(shuffled_images)
        shuffled_videos = video_files.copy()
        random.shuffle(shuffled_videos)
        # Mezcla: hasta 15 samples, priorizando imágenes (2:1 aprox)
        samples = []
        for i in range(15):
            if i % 3 == 2 and shuffled_videos:
                samples.append(("video", shuffled_videos.pop(0)))
            elif shuffled_images:
                samples.append(("image", shuffled_images.pop(0)))
            elif shuffled_videos:
                samples.append(("video", shuffled_videos.pop(0)))
            else:
                break
        categories.append({
            "name": folder.name,
            "count": len(files),
            "image_count": len(image_files),
            "video_count": len(video_files),
            "samples": samples,
        })
    return categories


def discover_categories_from_index(index_path: Path):
    """Build categories from docs/index.json (used by the auto-README workflow,
    so it never needs to clone the 19GB media tree)."""
    import json
    data = json.loads(index_path.read_text(encoding="utf-8"))
    categories = []
    for c in data.get("categories", []):
        if c.get("name") in ("NSFW", "Por organizar") or any(f.get("nsfw") for f in c.get("files", [])[:1]):
            continue
        files = [f["name"] for f in c["files"]]
        image_files = [f["name"] for f in c["files"] if f["kind"] == "image"]
        video_files = [f["name"] for f in c["files"] if f["kind"] == "video"]
        random.seed(c["name"])
        shuffled_images = image_files.copy()
        random.shuffle(shuffled_images)
        shuffled_videos = video_files.copy()
        random.shuffle(shuffled_videos)
        samples = []
        for i in range(15):
            if i % 3 == 2 and shuffled_videos:
                samples.append(("video", shuffled_videos.pop(0)))
            elif shuffled_images:
                samples.append(("image", shuffled_images.pop(0)))
            elif shuffled_videos:
                samples.append(("video", shuffled_videos.pop(0)))
            else:
                break
        categories.append({
            "name": c["name"],
            "count": len(files),
            "image_count": len(image_files),
            "video_count": len(video_files),
            "samples": samples,
        })
    return categories


def discover_characters(root: Path, min_count: int = 2, limit: int = 24):
    """Legacy: characters were removed from filenames; returns empty."""
    return []


def discover_characters_from_index(index_path: Path, min_count: int = 2, limit: int = 24):
    """Legacy: characters were removed; returns empty."""
    return []


def anchor(name: str) -> str:
    return name.lower().replace("_", "-").replace(" ", "-")


def badge(label: str, value: str, color: str) -> str:
    encoded = value.replace(" ", "%20")
    return f"https://img.shields.io/badge/{encoded}-{color}?style=for-the-badge&logo=none"


def media_tag(category: str, filename: str, kind: str, height: int) -> str:
    url = f"{category}/{quote(filename)}"
    if kind == "video":
        return (
            f'    <video src="{url}" height="{height}" controls '
            f'style="scroll-snap-align:start;margin-right:8px;border-radius:4px;'
            f'display:inline-block;background:#000;"></video>'
        )
    return (
        f'    <img src="{url}" height="{height}" '
        f'style="scroll-snap-align:start;margin-right:8px;border-radius:4px;'
        f'display:inline-block;">'
    )


def format_carousel(category: dict) -> str:
    name = category["name"]
    count = category["count"]
    videos = category["video_count"]
    samples = category["samples"]
    color = BADGE_COLORS.get(name, "7aa2f7")

    count_label = f"{count}%20files" if videos == 0 else f"{count}%20files%20({videos}%20videos)"
    lines = [
        f'<div align="center">',
        f"  <h2>{name}</h2>",
        "  <p>",
        f'    <img src="{badge(name, count_label, color)}" alt="{name}">',
        "  </p>",
    ]

    if samples:
        height = 180
        lines.append(
            f'  <div style="overflow-x:auto;overflow-y:hidden;white-space:nowrap;'
            f'scroll-snap-type:x mandatory;scroll-behavior:smooth;'
            f'background:#0d1117;border:1px solid #30363d;border-radius:8px;padding:8px;'
            f'max-width:960px;margin:0 auto;">'
        )
        for kind, sample in samples:
            lines.append(media_tag(name, sample, kind, height))
        lines.append("  </div>")

    lines.append("</div>")
    return "\n".join(lines)


def format_characters(characters: list) -> str:
    if not characters:
        return ""
    lines = [
        "<div align=\"center\">",
        "  <h2>Popular characters</h2>",
        "  <p>",
    ]
    for name, count in characters:
        color = "f7768e" if count >= 10 else "7aa2f7"
        display = name.replace("_", " ").replace("%20", " ")
        lines.append(
            f'    <img src="https://img.shields.io/badge/{quote(display)}-{count}-{color}'
            f'?style=for-the-badge&logo=none" alt="{display}">'
        )
    lines.append("  </p>")
    lines.append("</div>")
    return "\n".join(lines)


def generate_readme(categories: list, characters: list) -> str:
    total_files = sum(c["count"] for c in categories)
    total_videos = sum(c["video_count"] for c in categories)
    toc = "\n".join(f"- [{c['name']}](#{anchor(c['name'])}) — {c['count']} files" for c in categories)
    carousels = "\n\n---\n\n".join(format_carousel(c) for c in categories)
    video_note = (
        "\n> 🎞️ This collection includes **animated/live wallpapers** (MP4/WebM) — "
        "click the play button on video previews.\n" if total_videos else ""
    )
    chars_block = format_characters(characters)
    chars_section = f"\n---\n\n{chars_block}\n" if chars_block else ""

    gallery_link = "https://leriart.github.io/Wallpapers/"
    gallery_banner = f"""
<div align="center">
  <a href="{gallery_link}" style="display:inline-block;text-decoration:none;">
    <img src="https://img.shields.io/badge/Open%20Gallery-browse%2C%20preview%20%26%20download-6ea8fe?style=for-the-badge&logo=github" alt="Open Gallery">
  </a>
  <p>
    <a href="{gallery_link}"><strong>{gallery_link}</strong></a>
  </p>
</div>

---
"""

    return f"""<div align="center">
  <h1>WALLPAPERS</h1>
  <p>A curated collection of wallpapers organized by category.</p>
  <p>
    <img src="{badge('total', f'{total_files}%20files', '7aa2f7')}" alt="Total">
    <img src="{badge('categories', f'{len(categories)}%20categories', 'bb9af7')}" alt="Categories">
  </p>
</div>
{gallery_banner}
## Organized with <a href="https://github.com/leriart/Wanalizer">Wanalizer</a>

This collection is organized thanks to <strong>Wanalizer</strong>, an intelligent local wallpaper analyzer and categorizer.

---

## Table of contents

{toc}

---

{carousels}
{chars_section}
---

## File formats

The collection includes static and animated media:

| Format | Description |
|--------|-------------|
| JPG / JPEG / PNG / WEBP | Static wallpapers (photos, illustrations, pixel art) |
| GIF | Looping animated wallpapers |
| MP4 / WEBM | Live wallpapers (video) |

## How to use

1. Browse the <a href="{gallery_link}">online gallery</a> or open a category below.
2. Pick the wallpaper you want.
3. Download it or copy its raw URL to use it as your desktop or phone wallpaper.

## Contributing

Suggestions and contributions are welcome. If you want to add a new wallpaper, place it in the right category and follow the existing naming style (`Category_Character_tag1_tag2.ext`).

---

*This README was generated automatically. Do not edit it manually.*
"""


def main():
    import sys
    use_index = "--from-index" in sys.argv
    if use_index:
        index_path = REPO_ROOT / "docs" / "index.json"
        categories = discover_categories_from_index(index_path)
        characters = discover_characters_from_index(index_path)
    else:
        categories = discover_categories(REPO_ROOT)
        characters = discover_characters(REPO_ROOT)
    readme_path = REPO_ROOT / "README.md"
    readme_path.write_text(generate_readme(categories, characters), encoding="utf-8")
    print(f"Generated README.md with {len(categories)} categories.")
    total = sum(c["count"] for c in categories)
    videos = sum(c["video_count"] for c in categories)
    print(f"Total files: {total} ({videos} videos)")
    print(f"Characters listed: {len(characters)}")
    print(f"Source: {'docs/index.json' if use_index else 'filesystem'}")


if __name__ == "__main__":
    main()
