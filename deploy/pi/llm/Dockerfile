# Reads spoken bills into JSON for the API (server/src/lib/speech-llm.ts): llama.cpp's server
# running Qwen2.5 3B Instruct. The model is fetched at build time and checked against its
# published hash, so the running container needs no internet. The image is pinned by digest.
#
# Why this model: on the bill test sentences (server/src/lib/speech-bill.eval-data.ts) it read 4
# of 6 unseen phrasings right where the rules read 1; Qwen2.5 1.5B read 2 and Qwen3 1.7B 1. To
# try another GGUF model, pass MODEL_URL and MODEL_SHA256 as build args.
FROM ghcr.io/ggml-org/llama.cpp:server-b11641@sha256:3cd94856897235684192b0eec34071b5ef30c6dfd7b12e4504527073a7758b8c

ARG MODEL_URL=https://huggingface.co/Qwen/Qwen2.5-3B-Instruct-GGUF/resolve/main/qwen2.5-3b-instruct-q4_k_m.gguf
ARG MODEL_SHA256=626b4a6678b86442240e33df819e00132d3ba7dddfe1cdc4fbb18e0a9615c62d
RUN mkdir -p /models \
  && curl -fL --retry 3 -o /models/model.gguf "$MODEL_URL" \
  && echo "$MODEL_SHA256  /models/model.gguf" | sha256sum -c - \
  && chmod 644 /models/model.gguf

USER 65534
# One request at a time, on three cores. The instructions at the start of every request are kept
# in the cache, so only the new words are read each time.
CMD ["--model", "/models/model.gguf", "--host", "0.0.0.0", "--port", "8000", "--threads", "3", "--ctx-size", "4096", "--parallel", "1", "--jinja", "--no-webui"]
