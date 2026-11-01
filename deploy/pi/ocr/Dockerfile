# Local receipt OCR for the Pi. The small model ships inside the rapidocr package, so
# the running container needs no internet.
FROM python:3.12-slim

RUN pip install --no-cache-dir rapidocr==3.10.0 onnxruntime==1.31.1

WORKDIR /app
COPY server.py .

# Fails the build here if a model is missing or broken.
RUN python -c "import server; server.make_engine()"

USER 65534
CMD ["python", "server.py"]
