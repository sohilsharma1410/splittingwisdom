# Speech-to-text speed test for the Pi (plan D4.9). Models are fetched here at build
# time, because the test runs with no network access.
FROM python:3.12-slim

RUN pip install --no-cache-dir faster-whisper==1.2.1 ctranslate2==4.8.4 av==19.0.2 onnxruntime==1.31.1

WORKDIR /app
COPY spike.py score.py ./

ENV HF_HOME=/tmp/hf
RUN python -c "from faster_whisper import download_model; [download_model(n, output_dir=f'/models/{n}') for n in ('tiny.en', 'base.en')]" \
  && rm -rf /tmp/hf \
  && chmod -R a+rX /models

# Runs both models once, offline. This fails the build here if a model is missing or broken.
RUN HF_HUB_OFFLINE=1 python -c "from spike import warm_up; warm_up('tiny.en'); warm_up('base.en')"
ENV HF_HUB_OFFLINE=1
