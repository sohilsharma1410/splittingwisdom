"""Compares transcripts with what was said.

    python score.py <samples dir> <output dir>

- Word errors: the share of words wrong, added or lost. Lower is better.
- Names and dishes kept: of the names and dish words said, how many came through exactly.
  This is what the split depends on.
- Empty clips: nothing was said, so any text there is invented.
"""
import json
import re
import sys
from pathlib import Path

DIGITS = {"0": "zero", "1": "one", "2": "two", "3": "three", "4": "four", "5": "five", "6": "six", "7": "seven", "8": "eight", "9": "nine", "10": "ten"}


def words(text):
    text = text.lower().replace("’", "'").replace("-", " ")
    return [DIGITS.get(word, word) for word in re.sub(r"[^a-z0-9' ]", " ", text).split()]


def edit_distance(said, heard):
    previous = list(range(len(heard) + 1))
    for i, word in enumerate(said, 1):
        current = [i]
        for j, other in enumerate(heard, 1):
            current.append(min(previous[j] + 1, current[j - 1] + 1, previous[j - 1] + (word != other)))
        previous = current
    return previous[-1]


def main():
    samples, out_dir = Path(sys.argv[1]), Path(sys.argv[2])
    answers = json.loads((samples / "answers.json").read_text(encoding="utf-8"))
    keywords = set(answers["keywords"])
    runs = sorted(out_dir.glob("*.json"))
    if not runs:
        raise SystemExit(f"STOP: no results in {out_dir}")

    print(f"{'run':30} {'set':12} {'clips':>5} {'word errors':>11} {'names+dishes':>13} {'exact':>6}")
    for path in runs:
        run = json.loads(path.read_text(encoding="utf-8"))
        groups = {}
        for name, result in run["clips"].items():
            clip = answers["clips"][name]
            if "text" not in result:
                continue
            group = groups.setdefault(clip["set"], {"clips": 0, "errors": 0, "words": 0, "kept": 0, "keys": 0, "exact": 0, "invented": []})
            said, heard = words(clip["text"]), words(result["text"])
            group["clips"] += 1
            group["errors"] += edit_distance(said, heard)
            group["words"] += len(said)
            group["exact"] += said == heard
            pool = list(heard)
            for word in said:
                if word in keywords:
                    group["keys"] += 1
                    if word in pool:
                        group["kept"] += 1
                        pool.remove(word)
            if not said and heard:
                group["invented"].append(f"{name}: {result['text'][:80]}")
        for set_name, group in sorted(groups.items()):
            if set_name == "empty":
                print(f"{run['run']:30} {set_name:12} {group['clips']:>5} {'invented text in ' + str(len(group['invented'])):>25}")
                for line in group["invented"]:
                    print(f"    {line}")
                continue
            errors = f"{100 * group['errors'] / max(group['words'], 1):.1f}%"
            kept = f"{group['kept']}/{group['keys']}" if group["keys"] else "-"
            print(f"{run['run']:30} {set_name:12} {group['clips']:>5} {errors:>11} {kept:>13} {group['exact']:>6}")


if __name__ == "__main__":
    main()
