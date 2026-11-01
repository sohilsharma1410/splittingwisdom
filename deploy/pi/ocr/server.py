"""Local receipt OCR for the Pi (plan D18). The API posts an image and gets text boxes back.

Handles one scan at a time, so a scan can't take more than its CPU and memory limits.
Never logs images or the text it reads. Reachable only from the API, on a Docker
network with no internet access.
"""
import io
import json
import warnings
from http.server import BaseHTTPRequestHandler, HTTPServer

from PIL import Image, ImageDraw, ImageFont, ImageOps
from rapidocr import RapidOCR

PORT = 8000
THREADS = 3
MAX_BYTES = 12 * 1024 * 1024
LONGEST_EDGE = 2000
REQUEST_TIMEOUT_SECONDS = 30

# Refuses images built to use up memory when decoded.
Image.MAX_IMAGE_PIXELS = 40_000_000
warnings.simplefilter("error", Image.DecompressionBombWarning)


def make_engine():
    engine = RapidOCR(
        params={
            "Global.log_level": "error",
            "EngineConfig.onnxruntime.intra_op_num_threads": THREADS,
            "EngineConfig.onnxruntime.inter_op_num_threads": 1,
        }
    )
    # RapidOCR loads models on first use, so read real text now. A blank image would
    # stop before the recognition model.
    image = Image.new("RGB", (900, 200), "white")
    ImageDraw.Draw(image).text((40, 60), "TOTAL 123.45", fill="black", font=ImageFont.load_default(size=72))
    if not read_text(engine, image):
        raise RuntimeError("The OCR warm-up read nothing, so the models aren't working.")
    return engine


def read_text(engine, image):
    buffer = io.BytesIO()
    image.save(buffer, "JPEG", quality=85)
    result = engine(buffer.getvalue())
    texts = list(result.txts or [])
    if not texts:
        return []
    return [
        {
            "text": str(text),
            "confidence": round(float(score), 4),
            "box": [[round(float(point[0]), 1), round(float(point[1]), 1)] for point in box],
        }
        for text, score, box in zip(texts, result.scores, result.boxes)
    ]


def load_image(data):
    """Applies the phone's rotation, and shrinks anything that skipped the app's own resize."""
    with Image.open(io.BytesIO(data)) as image:
        image = ImageOps.exif_transpose(image).convert("RGB")
    image.thumbnail((LONGEST_EDGE, LONGEST_EDGE))
    return image


class Handler(BaseHTTPRequestHandler):
    timeout = REQUEST_TIMEOUT_SECONDS
    engine = None

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
        if self.path != "/ocr":
            self.send_json(404, {"error": "not found"})
            return
        try:
            length = int(self.headers.get("Content-Length", ""))
        except ValueError:
            self.send_json(411, {"error": "length required"})
            return
        if length <= 0 or length > MAX_BYTES:
            self.send_json(413, {"error": "image size not accepted"})
            return
        data = self.rfile.read(length)
        if len(data) != length:
            self.send_json(400, {"error": "incomplete image"})
            return
        try:
            image = load_image(data)
        except Exception:  # Pillow raises many types for bad images, including bombs.
            self.send_json(422, {"error": "not a readable image"})
            return
        try:
            self.send_json(200, {"boxes": read_text(self.engine, image)})
        except Exception as err:
            print(f"OCR failed: {type(err).__name__}", flush=True)
            self.send_json(500, {"error": "ocr failed"})


class Server(HTTPServer):
    request_queue_size = 16


def main():
    Handler.engine = make_engine()
    print(f"OCR ready on port {PORT}", flush=True)
    Server(("0.0.0.0", PORT), Handler).serve_forever()


if __name__ == "__main__":
    main()
