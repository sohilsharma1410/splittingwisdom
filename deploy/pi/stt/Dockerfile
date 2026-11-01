# Speech-to-text for the Pi. The model is fetched here at build time, so the running
# container needs no internet. Versions are the ones the D4.9 test used.
FROM python:3.12-slim

RUN pip install --no-cache-dir faster-whisper==1.2.1 ctranslate2==4.8.4 av==19.0.2 onnxruntime==1.31.1

WORKDIR /app
COPY server.py .

ENV HF_HOME=/tmp/hf
RUN python -c "from faster_whisper import download_model; download_model('base.en', output_dir='/models/base.en')" \
  && rm -rf /tmp/hf \
  && chmod -R a+rX /models

# Fails the build here if the model or the speech detector is missing or broken.
RUN HF_HUB_OFFLINE=1 python -c "import server; server.make_model()"
ENV HF_HUB_OFFLINE=1

USER 65534
CMD ["python", "server.py"]
