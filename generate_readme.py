#!/usr/bin/env python3
"""Generate README.md with dynamic image carousels from each category folder."""

import random
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent
IMAGE_EXTENSIONS = {".jpg", ".jpeg", ".png", ".webp", ".gif"}

BADGE_COLORS = {
    "Anime": "f7768e",
    "Catppuccin": "f5e0dc",
    "Cyberpunk": "7dcfff",
    "Dracula": "ff79c6",
    "Everforest": "a7c080",
    "Gruvbox": "fb4934",
    "Landscape": "7ee787",
    "Low-Quality": "8b949e",
    "Minecraft": "62b788",
    "Minimalist": "c0caf5",
    "Monochrome": "565f89",
    "Neon": "ff007c",
    "Nord": "5e81ac",
    "NSFW": "e06c75",
    "Phone": "ff9e64",
    "Pixel-Art": "e0af68",
    "Space": "7aa2f7",
    "Tokyonight": "565f89",
}


def discover_categories(root: Path):
    categories = []
    for folder in sorted(root.iterdir()):
        if not folder.is_dir() or folder.name.startswith("."):
            continue
        all_files = [
            f.name
            for f in folder.iterdir()
            if f.is_file()
        ]
        image_files = [
            f.name
            for f in folder.iterdir()
            if f.is_file() and f.suffix.lower() in IMAGE_EXTENSIONS
        ]
        all_files.sort(key=str.lower)
        image_files.sort(key=str.lower)
        random.seed(folder.name)  # deterministic but different per category
        shuffled = image_files.copy()
        random.shuffle(shuffled)
        categories.append({
            "name": folder.name,
            "count": len(all_files),
            "image_count": len(image_files),
            "samples": shuffled[:10],
        })
    return categories


def anchor(name: str) -> str:
    return name.lower().replace(" ", "-")


def badge(label: str, value: str, color: str) -> str:
    return f"https://img.shields.io/badge/{value}-{color}?style=for-the-badge&logo=none"


def format_carousel(category: dict) -> str:
    name = category["name"]
    count = category["count"]
    image_count = category["image_count"]
    samples = category["samples"]
    color = BADGE_COLORS.get(name, "7aa2f7")

    lines = [
        f'<div align="center">',
        f"  <h2>{name}</h2>",
        "  <p>",
        f'    <img src="{badge(name, f"{count}%20files", color)}" alt="{name}">',
        "  </p>",
    ]

    if name == "NSFW":
        lines.append("  <p><strong>Adult content.</strong> Browse the <code>NSFW/</code> folder directly.</p>")

    if samples:
        lines.append('  <marquee behavior="scroll" direction="left" scrollamount="4">')
        height = 220 if name == "Phone" else 160
        for sample in samples:
            sample_quoted = sample.replace(" ", "%20")
            lines.append(f'    <img src="{name}/{sample_quoted}" height="{height}">')
        lines.append("  </marquee>")

    lines.append("</div>")
    return "\n".join(lines)


def generate_readme(categories: list) -> str:
    total_files = sum(c["count"] for c in categories)
    toc = "\n".join(f"- [{c['name']}](#{anchor(c['name'])})" for c in categories)
    carousels = "\n\n---\n\n".join(format_carousel(c) for c in categories)

    return f"""<div align="center">
  <h1>WALLPAPERS</h1>
  <p>A curated collection of wallpapers organized by category.</p>
  <p>
    <img src="{badge('total', f'{total_files}%20files', '7aa2f7')}" alt="Total">
    <img src="{badge('categories', f'{len(categories)}%20categories', 'bb9af7')}" alt="Categories">
  </p>
</div>

---

## Organized with <a href="https://github.com/leriart/Wanalizer">Wanalizer</a>

This collection is organized thanks to <strong>Wanalizer</strong>, an intelligent local wallpaper analyzer and categorizer.

---

## Table of contents

{toc}

---

{carousels}

---

## File formats

The collection includes static and animated media:

| Format | Description |
|--------|-------------|
| JPG / JPEG | Photography and illustrations |
| PNG | Flat colors and transparent artwork |
| WEBP | High-performance images |
| GIF | Looping animated wallpapers |

## How to use

1. Open the category you like.
2. Pick the image you want.
3. Download it or copy its raw URL to use it as your desktop or phone wallpaper.

## Contributing

Suggestions and contributions are welcome. If you want to add a new wallpaper, place it in the right category and follow the existing naming style.

---

*This README was generated automatically. Do not edit it manually.*
"""


def main():
    categories = discover_categories(REPO_ROOT)
    readme_path = REPO_ROOT / "README.md"
    readme_path.write_text(generate_readme(categories), encoding="utf-8")
    print(f"Generated README.md with {len(categories)} categories.")


if __name__ == "__main__":
    main()
