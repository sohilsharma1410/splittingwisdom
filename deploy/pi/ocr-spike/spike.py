"""OCR speed test for the Pi (local OCR plan, step 1). Throwaway: replaced by the
real OCR service if the test passes. Writes nothing outside OUT_DIR.

    python spike.py <small|tiny> <photos dir> <output dir>

Writes <output dir>/<model>/<photo>.txt with the rows it read, and adds to
share-<model>.txt, a copy with GST, phone and card-like numbers masked.
"""
import io
import math
import re
import resource
import statistics
import sys
import time
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont, ImageOps
from rapidocr import ModelType, RapidOCR

SUPPORTED = {".jpg", ".jpeg", ".png", ".webp"}
THREADS = 3  # Leaves a core free for the app and Postgres.
LONGEST_EDGE = 2000  # Same limit as client/src/lib/downscale-image.ts.
TARGET_SECONDS = 20

MASKS = [
    (re.compile(r"(?<!\d)\d{2}[A-Z]{5}\d{4}[A-Z][0-9A-Z]{3}(?![0-9A-Z])", re.I), "[GSTIN]"),
    (re.compile(r"(?<!\d)\d(?:[ -]?\d){11,18}(?!\d)"), "[LONG NUMBER]"),
    (re.compile(r"(?<!\d)(?:\+?91[ -]?|0)?[6-9]\d{4}[ -]?\d{5}(?!\d)"), "[PHONE]"),
]


def make_engine(model):
    params = {
        "Global.log_level": "error",
        "EngineConfig.onnxruntime.intra_op_num_threads": THREADS,
        "EngineConfig.onnxruntime.inter_op_num_threads": 1,
    }
    if model == "tiny":
        params["Det.model_type"] = ModelType.TINY
        params["Rec.model_type"] = ModelType.TINY
    engine = RapidOCR(params=params)
    warm_up(engine)
    return engine


def warm_up(engine):
    """Forces the models to load, because RapidOCR otherwise waits for the first scan.
    Uses real text, since a blank image would stop before the recognition model."""
    image = Image.new("RGB", (900, 200), "white")
    ImageDraw.Draw(image).text((40, 60), "TOTAL 123.45", fill="black", font=ImageFont.load_default(size=72))
    buffer = io.BytesIO()
    image.save(buffer, "PNG")
    if not engine(buffer.getvalue()).txts:
        raise RuntimeError("The OCR warm-up read nothing, so the models aren't working.")


def load_like_the_app(path):
    """Applies the phone's rotation and shrinks the photo as the app's upload does."""
    with Image.open(path) as image:
        image = ImageOps.exif_transpose(image).convert("RGB")
    image.thumbnail((LONGEST_EDGE, LONGEST_EDGE))
    buffer = io.BytesIO()
    image.save(buffer, "JPEG", quality=85)
    return buffer.getvalue()


def to_rows(boxes, texts, scores):
    """Groups text boxes into rows, allowing for a tilted photo."""
    if not texts:
        return []
    angles, heights, parts = [], [], []
    for box, text, score in zip(boxes, texts, scores):
        (x0, y0), (x1, y1), _, (x3, y3) = [(float(p[0]), float(p[1])) for p in box]
        heights.append(math.hypot(x3 - x0, y3 - y0))
        if abs(x1 - x0) > abs(y1 - y0):
            angles.append(math.atan2(y1 - y0, x1 - x0))
    angle = statistics.median(angles) if angles else 0.0
    cos, sin = math.cos(angle), math.sin(angle)
    for box, text, score in zip(boxes, texts, scores):
        cx = sum(float(p[0]) for p in box) / 4
        cy = sum(float(p[1]) for p in box) / 4
        parts.append((cy * cos - cx * sin, cx * cos + cy * sin, str(text), float(score)))

    tolerance = statistics.median(heights) * 0.6
    rows = []
    for part in sorted(parts):
        if rows and abs(part[0] - statistics.mean(p[0] for p in rows[-1])) <= tolerance:
            rows[-1].append(part)
        else:
            rows.append([part])
    return [sorted(row, key=lambda p: p[1]) for row in rows]


def format_rows(rows):
    # "?" marks text the model was unsure of.
    return "\n".join(
        " | ".join(f"{p[2]}{' ?' if p[3] < 0.8 else ''}" for p in row) for row in rows
    )


def mask(text):
    for pattern, label in MASKS:
        text = pattern.sub(label, text)
    return text


def main():
    model, photos_dir, out_dir = sys.argv[1], Path(sys.argv[2]), Path(sys.argv[3])
    photos = sorted(p for p in photos_dir.iterdir() if p.is_file() and not p.name.startswith("."))
    readable = [p for p in photos if p.suffix.lower() in SUPPORTED]
    (out_dir / model).mkdir(parents=True, exist_ok=True)

    print(f"\n== Model: {model} ({THREADS} threads)")
    started = time.perf_counter()
    engine = make_engine(model)
    print(f"Load time: {time.perf_counter() - started:.1f}s")

    timings = []
    share = []
    for photo in photos:
        label = photo.name
        if photo not in readable:
            print(f"SKIP  {label}: not JPEG, PNG or WEBP")
            continue
        try:
            data = load_like_the_app(photo)
            started = time.perf_counter()
            result = engine(data)
            seconds = time.perf_counter() - started
            texts = list(result.txts or [])
            scores = list(result.scores or [])
            rows = to_rows(result.boxes if texts else [], texts, scores)
        except Exception as err:  # One bad photo shouldn't stop the test.
            print(f"ERROR {label}: {type(err).__name__}")
            continue
        timings.append(seconds)
        body = format_rows(rows)
        (out_dir / model / f"{photo.stem}.txt").write_text(body + "\n", encoding="utf-8")
        share.append(f"--- {photo.name} ---\n{mask(body)}\n")
        unsure = sum(1 for score in scores if score < 0.8)
        verdict = "ok " if seconds <= TARGET_SECONDS else "SLOW"
        print(f"{verdict}  {label}: {seconds:5.1f}s, {len(rows)} rows, {unsure} unsure")

    (out_dir / f"share-{model}.txt").write_text("\n".join(share), encoding="utf-8")
    peak_mb = resource.getrusage(resource.RUSAGE_SELF).ru_maxrss // 1024
    if timings:
        print(
            f"Result: {len(timings)} read, typical {statistics.median(timings):.1f}s, "
            f"slowest {max(timings):.1f}s, peak memory {peak_mb} MB"
        )
    else:
        print("Result: nothing was read")
        sys.exit(1)


if __name__ == "__main__":
    main()
