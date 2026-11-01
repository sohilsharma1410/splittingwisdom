"""Downloads public sample receipts and their correct answers for the OCR speed test.

    python fetch_samples.py <photos dir> <answers file> [receipts] [invoices]

The images are never stored in this repo.
- CORD-v2: real photos from Indonesian shops and restaurants. CC BY 4.0,
  Clova AI Research (huggingface.co/datasets/naver-clova-ix/cord-v2).
- Kirana invoices: synthetic Indian wholesale invoices. CC0
  (huggingface.co/datasets/build-small-hackathon/kirana-invoice-train-data).
"""
import io
import json
import sys
import urllib.parse
import urllib.request
from pathlib import Path

from PIL import Image, ImageOps

API = "https://datasets-server.huggingface.co/rows"
LONGEST_EDGE = 2000  # Sized like a phone photo after upload, so the timings are realistic.
PAGE = 100


def fetch(url):
    request = urllib.request.Request(url, headers={"User-Agent": "splittingwisdom-ocr-test"})
    with urllib.request.urlopen(request, timeout=60) as response:
        return response.read()


def rows(dataset, count):
    found = []
    while len(found) < count:
        query = urllib.parse.urlencode(
            {
                "dataset": dataset,
                "config": "default",
                "split": "test",
                "offset": len(found),
                "length": min(PAGE, count - len(found)),
            }
        )
        page = json.loads(fetch(f"{API}?{query}"))["rows"]
        if not page:
            break
        found.extend(page)
    return found


def first(value):
    return value[0] if isinstance(value, list) and value else value


def cord_answers(raw):
    parsed = json.loads(raw)["gt_parse"]
    menu = parsed.get("menu", [])
    menu = [menu] if isinstance(menu, dict) else menu
    items = [
        {"name": str(first(item.get("nm")) or ""), "prices": [str(first(item["price"]))]}
        for item in menu
        if first(item.get("price"))
    ]
    total = parsed.get("total")
    total = first(total.get("total_price")) if isinstance(total, dict) else None
    return {"items": items, "total": [str(total)] if total else []}


def kirana_answers(raw):
    parsed = json.loads(raw)
    # The invoices print whole rupees, while the answers keep the unrounded amount.
    items = [
        {
            "name": item["product_raw"],
            "prices": [f"{item['line_total']:.2f}", str(round(item["line_total"]))],
        }
        for item in parsed["items"]
    ]
    return {"items": items, "total": [f"{parsed['grand_total']:.2f}"]}


def save_photo(data, path):
    with Image.open(io.BytesIO(data)) as image:
        image = ImageOps.exif_transpose(image).convert("RGB")
    scale = LONGEST_EDGE / max(image.size)
    size = (round(image.width * scale), round(image.height * scale))
    image.resize(size, Image.LANCZOS).save(path, "JPEG", quality=85)


def main():
    photos, answers_file = Path(sys.argv[1]), Path(sys.argv[2])
    receipts = int(sys.argv[3]) if len(sys.argv) > 3 else 20
    invoices = int(sys.argv[4]) if len(sys.argv) > 4 else 4
    sources = [
        ("naver-clova-ix/cord-v2", "cord", receipts, "ground_truth", cord_answers),
        ("build-small-hackathon/kirana-invoice-train-data", "kirana", invoices, "response", kirana_answers),
    ]
    answers = {}
    for dataset, prefix, count, key, parse in sources:
        for row in rows(dataset, count):
            name = f"{prefix}-{row['row_idx']:03d}"
            save_photo(fetch(row["row"]["image"]["src"]), photos / f"{name}.jpg")
            answers[name] = parse(row["row"][key])
    answers_file.write_text(json.dumps(answers, ensure_ascii=False, indent=1), encoding="utf-8")
    print(f"Downloaded {len(answers)} public samples.")


if __name__ == "__main__":
    main()
