"""
Crop officer headshots for the About page so they all share the same framing.

Finds the face in each photo, cuts a 4:5 head-and-shoulders frame around it and writes
public/images/officers/<slug>.jpg (960x1200, or the photo's native size if it's smaller;
it never upscales). Camera metadata, including GPS, is stripped. Then set `photo` for that
officer in src/app/about/roster.ts.

    pip install opencv-python-headless pillow
    python apps/platform/scripts/crop-headshot.py ~/Downloads/IMG_0912.JPG=armando-martinez [more photo=slug ...]

Face detection uses OpenCV's YuNet model, downloaded once into ~/.cache/lsr/ on first run.
If a photo has several faces it uses the most confident one; check the output either way.
"""

import os
import sys
import urllib.request
from pathlib import Path

try:
    import cv2
    import numpy as np
    from PIL import Image, ImageOps
except ImportError:
    sys.exit("Needs OpenCV and Pillow: pip install opencv-python-headless pillow")

MODEL_URL = (
    "https://github.com/opencv/opencv_zoo/raw/main/models/"
    "face_detection_yunet/face_detection_yunet_2023mar.onnx"
)
MODEL_PATH = Path.home() / ".cache" / "lsr" / "face_detection_yunet_2023mar.onnx"
OUT_DIR = Path(__file__).resolve().parent.parent / "public" / "images" / "officers"

OUT_W, OUT_H = 960, 1200  # 4:5, matches the board tiles on /about
FACE_FRAC = 0.30          # face width as a share of the crop width
FACE_CY = 0.34            # face centre as a share of the crop height


def detector():
    if not MODEL_PATH.exists():
        MODEL_PATH.parent.mkdir(parents=True, exist_ok=True)
        print(f"Downloading face model to {MODEL_PATH}")
        urllib.request.urlretrieve(MODEL_URL, MODEL_PATH)
    return cv2.FaceDetectorYN.create(str(MODEL_PATH), "", (320, 320), score_threshold=0.7)


def crop(det, src: Path, slug: str) -> None:
    im = ImageOps.exif_transpose(Image.open(src)).convert("RGB")
    w, h = im.size
    scale = 1000 / w
    small = cv2.cvtColor(np.array(im.resize((1000, round(h * scale)))), cv2.COLOR_RGB2BGR)
    det.setInputSize((small.shape[1], small.shape[0]))
    _, faces = det.detect(small)
    if faces is None or len(faces) == 0:
        print(f"{src.name}: no face found, skipped")
        return

    fx, fy, fw, fh = (v / scale for v in max(faces, key=lambda f: f[-1])[:4])
    cw = fw / FACE_FRAC
    ch = cw * OUT_H / OUT_W
    left = min(max(0, fx + fw / 2 - cw / 2), w - cw)
    top = min(max(0, fy + fh / 2 - FACE_CY * ch), h - ch)
    out = im.crop((round(left), round(top), round(left + cw), round(top + ch)))
    if out.width > OUT_W:
        out = out.resize((OUT_W, OUT_H), Image.LANCZOS)

    OUT_DIR.mkdir(parents=True, exist_ok=True)
    dest = OUT_DIR / f"{slug}.jpg"
    out.save(dest, "JPEG", quality=84, optimize=True, progressive=True)  # no exif= : metadata dropped
    print(f"{src.name} -> {dest.relative_to(OUT_DIR.parent.parent.parent)} ({out.width}x{out.height})")
    if out.width < OUT_W:
        print(f"  note: source is small, so this one is {out.width}px wide instead of {OUT_W}")


def main(args: list[str]) -> None:
    pairs = [a.split("=", 1) for a in args]
    if not pairs or any(len(p) != 2 or not p[1] for p in pairs):
        sys.exit(__doc__)
    det = detector()
    for photo, slug in pairs:
        crop(det, Path(os.path.expanduser(photo)), slug)


if __name__ == "__main__":
    main(sys.argv[1:])
