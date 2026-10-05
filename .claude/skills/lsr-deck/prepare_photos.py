"""Resize the LSR deck photos for upload to a Slides artifact.

    python .claude/skills/lsr-deck/prepare_photos.py <out-dir>

Writes 2400px JPEGs (1600px for the portrait shot) of the photos the deck templates use,
plus copies of the white and black logos. Needs Pillow (pip install pillow). Run it from
the repo root.
"""
import shutil
import sys
from pathlib import Path

from PIL import Image, ImageOps

IMAGES = Path("apps/platform/public/images")
LOGOS = Path("apps/platform/public/brand/logos")

# source file -> (output name, longest side in px)
PHOTOS = {
    "lsr-hero.webp": ("cover-mercedes.jpg", 2400),
    "gal_03.jpeg": ("night-porsche.jpg", 2400),
    "gal_04.jpeg": ("pit-porsche.jpg", 2400),
    "gal_05.JPG": ("pit-mercedes.jpg", 2400),
    "gal_11.jpg": ("garage.jpg", 2400),
    "gal_08.jpeg": ("members-rigs.jpg", 1600),
}
LOGO_FILES = {"white_logo.png": "lsr-white.png", "black_logo.png": "lsr-black.png"}


def main() -> None:
    if len(sys.argv) != 2:
        sys.exit("Usage: prepare_photos.py <out-dir>")
    if not IMAGES.is_dir():
        sys.exit("Run this from the repo root.")
    out = Path(sys.argv[1])
    out.mkdir(parents=True, exist_ok=True)

    for src, (name, longest) in PHOTOS.items():
        image = ImageOps.exif_transpose(Image.open(IMAGES / src)).convert("RGB")
        image.thumbnail((longest, longest), Image.LANCZOS)
        target = out / name
        image.save(target, "JPEG", quality=86, optimize=True, progressive=True)
        print(f"{name:20s} {image.size[0]}x{image.size[1]}  {target.stat().st_size // 1024} KB")

    for src, name in LOGO_FILES.items():
        shutil.copy(LOGOS / src, out / name)
        print(f"{name:20s} copied")


if __name__ == "__main__":
    main()
