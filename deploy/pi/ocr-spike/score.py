"""Compares the OCR text with the sample answers.

    python score.py <results dir> <answers file>

A value counts as found if it appears anywhere in that photo's text. This measures
what the OCR can read, not whether a price is matched to the right item: that's the
parser's job, tested later. Separators are ignored, so 1,500.00 matches 1500.00.
"""
import json
import re
import sys
from pathlib import Path


def digits(value):
    return re.sub(r"\D", "", str(value))


def squash(value):
    return re.sub(r"\s", "", str(value)).lower()


def score(text, answer):
    tokens = {digits(part) for part in re.split(r"[|\s]+", text)}
    tokens |= {digits(part) for part in text.splitlines()}
    page = squash(text.replace("|", " "))
    found = lambda options: any(digits(option) in tokens for option in options)
    return {
        "prices": sum(found(item["prices"]) for item in answer["items"]),
        "names": sum(bool(item["name"]) and squash(item["name"]) in page for item in answer["items"]),
        "items": len(answer["items"]),
        "totals": int(found(answer["total"])) if answer["total"] else 0,
        "total_count": 1 if answer["total"] else 0,
    }


def main():
    results, answers = Path(sys.argv[1]), json.loads(Path(sys.argv[2]).read_text(encoding="utf-8"))
    print("\n== Accuracy on the public samples")
    for model in ("tiny", "small"):
        groups = {}
        missing = 0
        for name, answer in answers.items():
            path = results / model / f"{name}.txt"
            if not path.exists():
                missing += 1
                continue
            line = score(path.read_text(encoding="utf-8"), answer)
            group = groups.setdefault(name.split("-")[0], dict.fromkeys(line, 0))
            for key, value in line.items():
                group[key] += value
        for source, g in sorted(groups.items()):
            print(
                f"{model:5} {source:6}: prices {g['prices']}/{g['items']}, "
                f"item names {g['names']}/{g['items']}, totals {g['totals']}/{g['total_count']}"
            )
        if missing:
            print(f"{model:5}: {missing} photos have no result")


if __name__ == "__main__":
    main()
