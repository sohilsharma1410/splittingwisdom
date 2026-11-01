"""Speech-to-text for the Pi (plan D4.10). The API posts a recording and gets text back.

Handles one recording at a time. Audio is held in memory only and dropped as soon as it has
been read. Never logs audio or what it said. Reachable only from the API, on a Docker network
with no internet access. Settings come from the D4.9 test: base.en, int8, 3 threads, one beam,
no retries (retries are what made noise slow, and they hallucinated the prompt back).
"""
import io
import json
import os
from http.server import BaseHTTPRequestHandler, HTTPServer
from urllib.parse import unquote

import av
import numpy as np
from faster_whisper import WhisperModel

PORT = 8000
THREADS = 3
RATE = 16000
MODEL = os.environ.get("STT_MODEL", "base.en")
MODELS_DIR = os.environ.get("STT_MODELS_DIR", "/models")
MAX_BYTES = 4 * 1024 * 1024
MAX_SECONDS = 75
MAX_PROMPT = 800
REQUEST_TIMEOUT_SECONDS = 60


def make_model():
    model = WhisperModel(f"{MODELS_DIR}/{MODEL}", device="cpu", compute_type="int8", cpu_threads=THREADS, num_workers=1, local_files_only=True)
    # Reads noise through both paths once, so a missing model or speech detector fails the build.
    noise = np.random.default_rng(1).normal(0, 0.1, RATE).astype(np.float32)
    list(model.transcribe(noise, language="en", beam_size=1, vad_filter=False)[0])
    list(model.transcribe(noise, language="en", beam_size=1, vad_filter=True)[0])
    return model


def decode_audio(data):
    """Reads whatever the browser recorded (webm/opus, mp4, ogg, wav) into 16 kHz mono floats.
    faster-whisper's own decoder doesn't work with current versions of av (found in D4.9)."""
    with av.open(io.BytesIO(data)) as container:
        resampler = av.AudioResampler(format="flt", layout="mono", rate=RATE)
        parts = []
        total = 0
        for frame in container.decode(audio=0):
            for out in resampler.resample(frame):
                chunk = out.to_ndarray().reshape(-1)
                total += len(chunk)
                if total > MAX_SECONDS * RATE:
                    raise OverflowError("too long")
                parts.append(chunk)
        for out in resampler.resample(None):
            parts.append(out.to_ndarray().reshape(-1))
    if not parts:
        raise ValueError("no audio")
    return np.concatenate(parts).astype(np.float32)


def transcribe(model, audio, prompt):
    options = {"initial_prompt": prompt} if prompt else {}
    segments, _ = model.transcribe(
        audio,
        language="en",
        beam_size=1,
        vad_filter=True,
        condition_on_previous_text=False,
        temperature=0.0,
        **options,
    )
    return " ".join(segment.text.strip() for segment in segments).strip()


class Handler(BaseHTTPRequestHandler):
    timeout = REQUEST_TIMEOUT_SECONDS
    model = None

    def log_message(self, format, *args):
        pass

    def send_json(self, status, body):
        payload = json.dumps(body).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(payload)))
        self.send_header("Connection", "close")
        self.end_headers()
        self.wfile.write(payload)
        self.close_connection = True

    def do_GET(self):
        if self.path == "/health":
            self.send_json(200, {"ok": True})
        else:
            self.send_json(404, {"error": "not found"})

    def do_POST(self):
        if self.path != "/transcribe":
            self.send_json(404, {"error": "not found"})
            return
        try:
            length = int(self.headers.get("Content-Length", ""))
        except ValueError:
            self.send_json(411, {"error": "length required"})
            return
        if length <= 0 or length > MAX_BYTES:
            self.send_json(413, {"error": "recording size not accepted"})
            return
        data = self.rfile.read(length)
        if len(data) != length:
            self.send_json(400, {"error": "incomplete recording"})
            return
        prompt = unquote(self.headers.get("X-Prompt", ""))[:MAX_PROMPT]
        try:
            audio = decode_audio(data)
        except OverflowError:
            self.send_json(413, {"error": "recording too long"})
            return
        except Exception:  # av raises many types for bad input.
            self.send_json(422, {"error": "not a readable recording"})
            return
        finally:
            del data
        try:
            self.send_json(200, {"text": transcribe(self.model, audio, prompt)})
        except Exception as err:
            print(f"Speech recognition failed: {type(err).__name__}", flush=True)
            self.send_json(500, {"error": "recognition failed"})


class Server(HTTPServer):
    request_queue_size = 8


def main():
    Handler.model = make_model()
    print(f"Speech recognition ready on port {PORT}", flush=True)
    Server(("0.0.0.0", PORT), Handler).serve_forever()


if __name__ == "__main__":
    main()
