#!/usr/bin/env python3
"""Generate README.md with CSS-only image carousels (radio buttons + arrows + dots)."""

import random
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent
IMAGE_EXTENSIONS = {".jpg", ".jpeg", ".png", ".webp", ".gif"}
SLIDES_PER_CATEGORY = 5

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


def slug(name: str) -> str:
    return name.lower().replace(" ", "-").replace("-", "")


def discover_categories(root: Path):
    categories = []
    for folder in sorted(root.iterdir()):
        if not folder.is_dir() or folder.name.startswith("."):
            continue
        all_files = [
            f.name for f in folder.iterdir() if f.is_file()
        ]
        image_files = [
            f.name for f in folder.iterdir()
            if f.is_file() and f.suffix.lower() in IMAGE_EXTENSIONS
        ]
        all_files.sort(key=str.lower)
        image_files.sort(key=str.lower)
        random.seed(folder.name)
        shuffled = image_files.copy()
        random.shuffle(shuffled)
        categories.append({
            "name": folder.name,
            "count": len(all_files),
            "image_count": len(image_files),
            "samples": shuffled[:SLIDES_PER_CATEGORY],
        })
    return categories


def anchor(name: str) -> str:
    return name.lower().replace(" ", "-")


def badge(label: str, value: str, color: str) -> str:
    return f"https://img.shields.io/badge/{value}-{color}?style=for-the-badge&logo=none"


def generate_css(categories: list) -> str:
    rules = []

    for cat in categories:
        ns = slug(cat["name"])
        n = len(cat["samples"])
        if n == 0:
            continue

        rules.append(f"/* {cat['name']} */")

        # Slide track transforms
        rules.append(f".c-{ns} .r-{ns} {{ display: none; }}")
        for i in range(n):
            rules.append(
                f"#r-{ns}-{i}:checked ~ .t-{ns} "
                f"{{ transform: translateX(-{i * 100}%); }}"
            )

        # Arrow visibility — each prev/next arrow only shows when its source slide is active
        for i in range(n):
            rules.append(f".ap-{ns}-{i} {{ display: none; }}")
            rules.append(f".an-{ns}-{i} {{ display: none; }}")
            rules.append(f"#r-{ns}-{i}:checked ~ .ap-{ns}-{i} {{ display: flex; }}")
            rules.append(f"#r-{ns}-{i}:checked ~ .an-{ns}-{i} {{ display: flex; }}")

        # Dot active state
        for i in range(n):
            rules.append(
                f"#r-{ns}-{i}:checked ~ .ds-{ns} "
                f"label[for=r-{ns}-{i}] "
                f"{{ background: #7aa2f7; }}"
            )

    return "\n".join(rules)


def format_carousel(cat: dict) -> str:
    name = cat["name"]
    count = cat["count"]
    samples = cat["samples"]
    color = BADGE_COLORS.get(name, "7aa2f7")
    ns = slug(name)
    height = 260 if name == "Phone" else 220
    n = len(samples)

    lines = [
        f'<div align="center">',
        f"  <h2>{name}</h2>",
        "  <p>",
        f'    <img src="{badge(name, f"{count}%20files", color)}" alt="{name}">',
        "  </p>",
    ]

    if name == "NSFW":
        lines.append(
            "  <p><strong>Adult content.</strong> "
            "Browse the <code>NSFW/</code> folder directly.</p>"
        )

    if samples:
        lines.append(
            f'  <div class="c-{ns}" '
            f'style="position:relative;max-width:660px;margin:0 auto;'
            f'background:#0d1117;border:1px solid #30363d;border-radius:8px;'
            f'overflow:hidden;">'
        )

        # Radio buttons
        for i, sample in enumerate(samples):
            checked = " checked" if i == 0 else ""
            lines.append(
                f'    <input class="r-{ns}" type="radio" '
                f'name="s-{ns}" id="r-{ns}-{i}"{checked}>'
            )

        # Slide track
        lines.append(
            f'    <div class="t-{ns}" '
            f'style="display:flex;transition:transform 0.4s ease;">'
        )
        for sample in samples:
            sample_quoted = sample.replace(" ", "%20")
            lines.append(
                f'      <div style="min-width:100%;text-align:center;'
                f'line-height:0;">'
                f'<img src="{name}/{sample_quoted}" height="{height}" '
                f'style="object-fit:contain;border-radius:2px;">'
                f'</div>'
            )
        lines.append("    </div>")

        # Prev arrows (each visible only when its source slide is active)
        for i in range(n):
            prev = (i - 1) % n
            lines.append(
                f'    <label class="ap-{ns}-{i}" for="r-{ns}-{prev}" '
                f'style="position:absolute;left:6px;top:50%;transform:translateY(-50%);'
                f'width:32px;height:32px;background:rgba(13,17,23,0.75);'
                f'border-radius:50%;align-items:center;justify-content:center;'
                f'color:#c0caf5;font-size:18px;cursor:pointer;user-select:none;'
                f'text-decoration:none;">&#9664;</label>'
            )

        # Next arrows
        for i in range(n):
            nxt = (i + 1) % n
            lines.append(
                f'    <label class="an-{ns}-{i}" for="r-{ns}-{nxt}" '
                f'style="position:absolute;right:6px;top:50%;transform:translateY(-50%);'
                f'width:32px;height:32px;background:rgba(13,17,23,0.75);'
                f'border-radius:50%;align-items:center;justify-content:center;'
                f'color:#c0caf5;font-size:18px;cursor:pointer;user-select:none;'
                f'text-decoration:none;">&#9654;</label>'
            )

        # Dots bar
        lines.append(
            f'    <div class="ds-{ns}" '
            f'style="display:flex;justify-content:center;gap:8px;padding:8px 0;">'
        )
        for i in range(n):
            bg = "#7aa2f7" if i == 0 else "#30363d"
            lines.append(
                f'      <label for="r-{ns}-{i}" '
                f'style="width:10px;height:10px;background:{bg};'
                f'border-radius:50%;cursor:pointer;display:inline-block;">'
                f'</label>'
            )
        lines.append("    </div>")

        lines.append("  </div>")

    lines.append("</div>")
    return "\n".join(lines)


def generate_readme(categories: list) -> str:
    total_files = sum(c["count"] for c in categories)
    toc = "\n".join(
        f"- [{c['name']}](#{anchor(c['name'])})" for c in categories
    )
    carousels = "\n\n---\n\n".join(format_carousel(c) for c in categories)
    css = generate_css(categories)

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

<style>
{css}
</style>
"""


def main():
    categories = discover_categories(REPO_ROOT)
    readme_path = REPO_ROOT / "README.md"
    readme_path.write_text(generate_readme(categories), encoding="utf-8")
    print(f"Generated README.md with {len(categories)} categories.")


if __name__ == "__main__":
    main()
