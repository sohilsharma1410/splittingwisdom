"""Speech-to-text speed test for the Pi (plan D4.9). Throwaway: replaced by the real
service if the test passes. Writes nothing outside the output dir.

    python spike.py <run name> <tiny.en|base.en> <none|prompt|hotwords> <beam> <samples dir> <output dir> [only sets, comma separated]

Writes <output dir>/<run name>.json with each clip's text and timing.
"""
import json
import os
import resource
import statistics
import sys
import time
from pathlib import Path

import av
import numpy as np
from faster_whisper import WhisperModel

THREADS = 3  # Leaves a core free for the app and Postgres.
MODELS_DIR = os.environ.get("STT_MODELS_DIR", "/models")
RATE = 16000


def load_model(name):
    return WhisperModel(f"{MODELS_DIR}/{name}", device="cpu", compute_type="int8", cpu_threads=THREADS, num_workers=1, local_files_only=True)


def decode_audio(path):
    """faster-whisper 1.2.1's own decoder doesn't work with current versions of av, and
    current av matters here because the real service will read uploaded audio."""
    with av.open(str(path)) as container:
        resampler = av.AudioResampler(format="flt", layout="mono", rate=RATE)
        parts = []
        for frame in container.decode(audio=0):
            parts.extend(out.to_ndarray().reshape(-1) for out in resampler.resample(frame))
        parts.extend(out.to_ndarray().reshape(-1) for out in resampler.resample(None))
    return np.concatenate(parts).astype(np.float32)


def warm_up(name):
    """Fails the image build if the model or the speech detector is missing or broken."""
    model = load_model(name)
    noise = np.random.default_rng(1).normal(0, 0.1, RATE).astype(np.float32)
    list(model.transcribe(noise, language="en", beam_size=1, vad_filter=False)[0])
    list(model.transcribe(noise, language="en", beam_size=1, vad_filter=True)[0])


def transcribe(model, audio, prompt_mode, prompt, beam):
    options = {}
    if prompt_mode == "prompt" and prompt:
        options["initial_prompt"] = prompt
    if prompt_mode == "hotwords" and prompt:
        options["hotwords"] = prompt
    if os.environ.get("STT_NO_RETRY"):
        # Whisper normally retries audio it can't make sense of, which is slow on noise.
        options["temperature"] = 0.0
    segments, _ = model.transcribe(
        audio,
        language="en",
        beam_size=beam,
        vad_filter=True,
        condition_on_previous_text=False,
        **options,
    )
    return " ".join(segment.text.strip() for segment in segments).strip()


def main():
    run, model_name, prompt_mode, beam = sys.argv[1], sys.argv[2], sys.argv[3], int(sys.argv[4])
    samples, out_dir = Path(sys.argv[5]), Path(sys.argv[6])
    only = set(sys.argv[7].split(",")) if len(sys.argv) > 7 else None
    answers = json.loads((samples / "answers.json").read_text(encoding="utf-8"))

    started = time.perf_counter()
    model = load_model(model_name)
    load_seconds = time.perf_counter() - started

    results = {}
    for name, clip in sorted(answers["clips"].items()):
        if only and clip["set"] not in only:
            continue
        try:
            audio = decode_audio(samples / "clips" / name)
            started = time.perf_counter()
            text = transcribe(model, audio, prompt_mode, answers["prompt"] if clip["prompt"] else None, beam)
            results[name] = {"text": text, "seconds": time.perf_counter() - started, "audio": len(audio) / RATE}
        except Exception as err:  # One bad clip shouldn't stop the test.
            results[name] = {"error": type(err).__name__}
            print(f"ERROR {name}: {type(err).__name__}: {err}", flush=True)

    peak_mb = resource.getrusage(resource.RUSAGE_SELF).ru_maxrss // 1024
    out_dir.mkdir(parents=True, exist_ok=True)
    (out_dir / f"{run}.json").write_text(
        json.dumps({"run": run, "model": model_name, "prompt": prompt_mode, "beam": beam, "load": load_seconds, "peak_mb": peak_mb, "clips": results}, indent=1),
        encoding="utf-8",
    )
    done = [r for r in results.values() if "seconds" in r]
    if not done:
        print(f"{run}: nothing was transcribed")
        sys.exit(1)
    long_clips = [r["seconds"] for r in done if r["audio"] >= 15]
    print(
        f"{run}: {len(done)} clips, load {load_seconds:.1f}s, typical {statistics.median(r['seconds'] for r in done):.1f}s, "
        f"slowest {max(r['seconds'] for r in done):.1f}s, "
        + (f"clips of 15s or more: slowest {max(long_clips):.1f}s, " if long_clips else "")
        + f"{sum(r['seconds'] for r in done) / sum(r['audio'] for r in done):.2f}s per second of speech, peak memory {peak_mb} MB",
        flush=True,
    )


if __name__ == "__main__":
    main()
