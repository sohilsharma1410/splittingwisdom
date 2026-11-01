# OCR speed test for the Pi. Models are fetched here at build time, because the
# test runs with no network access.
FROM python:3.12-slim

RUN pip install --no-cache-dir rapidocr==3.10.0 onnxruntime==1.31.1

WORKDIR /app
COPY spike.py fetch_samples.py score.py ./

# Loads both models and reads a test image. This downloads the tiny models, and fails
# the build here if a model is missing or broken.
RUN python -c "from spike import make_engine; make_engine('small'); make_engine('tiny')"
