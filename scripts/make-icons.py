#!/usr/bin/env python3
"""Generates the Central Dogma icon set from assets/icon-source.webp.

The source is pixel-art Asuka at 1254x1254 with a transparent background.
Everything is flattened onto the board's plum so the iOS home-screen icon is
opaque -- iOS ignores alpha and would otherwise composite the art onto black.

Run from anywhere:  python scripts/make-icons.py
Requires Pillow.
"""

from pathlib import Path
from PIL import Image

ROOT = Path(__file__).resolve().parent.parent
SOURCE = ROOT / "assets" / "icon-source.webp"

# Matches manifest.ts background_color / theme_color.
BACKGROUND = (20, 19, 39)

# Plain icons: art fills the square. Maskable: art shrinks so Android's circle
# crop (which can eat the outer ~20%) never clips her face.
MASKABLE_ART_FRACTION = 0.72

OUTPUTS = [
    ("public/apple-touch-icon.png", 180, False),
    ("public/icons/icon-32.png", 32, False),
    ("public/icons/icon-64.png", 64, False),
    ("public/icons/icon-192.png", 192, False),
    ("public/icons/icon-512.png", 512, False),
    ("public/icons/icon-512-maskable.png", 512, True),
]


def flatten(art: Image.Image, size: int) -> Image.Image:
    canvas = Image.new("RGB", (size, size), BACKGROUND)
    canvas.paste(art, (0, 0), art)
    return canvas


def render(src: Image.Image, size: int, maskable: bool) -> Image.Image:
    if not maskable:
        return flatten(src.resize((size, size), Image.LANCZOS), size)

    art_size = round(size * MASKABLE_ART_FRACTION)
    art = src.resize((art_size, art_size), Image.LANCZOS)
    canvas = Image.new("RGB", (size, size), BACKGROUND)
    offset = (size - art_size) // 2
    canvas.paste(art, (offset, offset), art)
    return canvas


def main() -> None:
    src = Image.open(SOURCE).convert("RGBA")
    for rel, size, maskable in OUTPUTS:
        out = ROOT / rel
        out.parent.mkdir(parents=True, exist_ok=True)
        render(src, size, maskable).save(out, "PNG", optimize=True)
        print(f"{rel}  {size}x{size}  ({out.stat().st_size} bytes)")


if __name__ == "__main__":
    main()
