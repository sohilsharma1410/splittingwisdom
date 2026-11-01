#!/usr/bin/env bash
# Try the voice features on this Mac, in your own browser — no Pi, no tunnel, no Supabase.
#
#   scripts/voice-local.sh setup      # one time: installs the speech engine (faster-whisper) and the base.en model
#   scripts/voice-local.sh            # real speech recognition (needs setup)
#   VOICE_STT=fake scripts/voice-local.sh   # no model: the "speech" is whatever you put in .localdb/fake-stt.txt
#
# Opens http://localhost:4573 with demo users Ann, Bob and Cat (password demo-pass-123) and the group
# "Goa trip (demo)". Throwaway database; nothing leaves this machine. Receipts are read by a canned
# fake reader. Ctrl-C stops everything.
set -euo pipefail
cd "$(dirname "$0")/.."
ROOT="$PWD"; PIDS="$ROOT/.localdb/pids"; mkdir -p "$PIDS" "$ROOT/.localdb/receipts-voice"
VENV="$ROOT/.localdb/stt-venv"; MODELS="$ROOT/.localdb/stt-models"
API=4500; WEB=4573; STT_PORT=4291

if [ "${1:-}" = "setup" ]; then
  # The Pi image uses Python 3.12; the system python on a Mac is often too old for these versions.
  PY="$(command -v python3.12 || command -v python3.13 || command -v python3.11 || true)"
  [ -n "$PY" ] || { echo "Need Python 3.11 or newer (brew install python@3.12)" >&2; exit 1; }
  rm -rf "$VENV"; "$PY" -m venv "$VENV"
  # The Pi pins av 19, which needs Python 3.12; on an older Python take the newest av it can run (same decoding calls).
  AV=19.0.2; "$VENV/bin/python" -c 'import sys; sys.exit(0 if sys.version_info >= (3, 12) else 1)' || AV=18.1.0
  "$VENV/bin/pip" install --quiet faster-whisper==1.2.1 ctranslate2==4.8.4 "av==$AV" onnxruntime==1.31.1
  HF_HOME="$ROOT/.localdb/hf" "$VENV/bin/python" -c "from faster_whisper import download_model; download_model('base.en', output_dir='$MODELS/base.en')"
  echo "Speech engine installed. Run scripts/voice-local.sh"
  exit 0
fi

MODE="${VOICE_STT:-whisper}"
if [ "$MODE" = "whisper" ] && [ ! -d "$MODELS/base.en" ]; then
  echo "The speech engine isn't installed yet. Run:  scripts/voice-local.sh setup" >&2
  echo "(or try without a model:  VOICE_STT=fake scripts/voice-local.sh)" >&2
  exit 1
fi

DB_URL="$(scripts/local-pg.sh voice 54380 start)"
node scripts/link-drizzle-orm.mjs >/dev/null
scripts/local-pg.sh voice 54380 reset >/dev/null
(cd server && DATABASE_URL="$DB_URL" npx drizzle-kit migrate >/dev/null 2>&1)

started=()
cleanup() { for f in "${started[@]:-}"; do [ -f "$f" ] && { pkill -P "$(cat "$f")" 2>/dev/null || true; kill "$(cat "$f")" 2>/dev/null || true; }; done; scripts/local-pg.sh voice 54380 stop; }
trap cleanup EXIT INT TERM

# Receipts: the canned fake reader (so the scan flow works with no key).
(nohup node scripts/fake-vision-model.mjs 4290 > "$ROOT/.localdb/fake-model-voice.log" 2>&1 & echo $! > "$PIDS/fake-model-voice.pid"); started+=("$PIDS/fake-model-voice.pid")

# Speech.
if [ "$MODE" = "fake" ]; then
  : > "$ROOT/.localdb/fake-stt.txt"
  (FAKE_STT_FILE="$ROOT/.localdb/fake-stt.txt" nohup node scripts/fake-stt.mjs $STT_PORT > "$ROOT/.localdb/stt-voice.log" 2>&1 & echo $! > "$PIDS/stt-voice.pid"); started+=("$PIDS/stt-voice.pid")
else
  # Same server.py the Pi container runs, on port 8000 there and $STT_PORT here.
  sed "s/^PORT = 8000/PORT = $STT_PORT/" deploy/pi/stt/server.py > "$ROOT/.localdb/stt-server.py"
  (STT_MODELS_DIR="$MODELS" HF_HUB_OFFLINE=1 nohup "$VENV/bin/python" "$ROOT/.localdb/stt-server.py" > "$ROOT/.localdb/stt-voice.log" 2>&1 & echo $! > "$PIDS/stt-voice.pid"); started+=("$PIDS/stt-voice.pid")
fi
for _ in $(seq 1 90); do curl -sf "http://127.0.0.1:$STT_PORT/health" >/dev/null 2>&1 && break; sleep 1; done
curl -sf "http://127.0.0.1:$STT_PORT/health" >/dev/null || { echo "The speech service didn't start. See .localdb/stt-voice.log" >&2; exit 1; }

(cd server && DATABASE_URL="$DB_URL" SESSION_SECRET=voice-local PORT=$API NODE_ENV=development STORAGE_DRIVER=local RECEIPTS_DIR="$ROOT/.localdb/receipts-voice" \
  OCR_PROVIDER=ollama OCR_BASE_URL=http://127.0.0.1:4290/v1 OCR_MODEL=fake-vision STT_URL="http://127.0.0.1:$STT_PORT" \
  nohup npx tsx src/index.ts > "$ROOT/.localdb/api-voice.log" 2>&1 & echo $! > "$PIDS/api-voice.pid"); started+=("$PIDS/api-voice.pid")
npm run build --workspace=shared >/dev/null
(cd client && npx vite build >/dev/null)
(cd client && PREVIEW_API_URL="http://localhost:$API" nohup npx vite preview --host localhost --port $WEB --strictPort > "$ROOT/.localdb/web-voice.log" 2>&1 & echo $! > "$PIDS/web-voice.pid"); started+=("$PIDS/web-voice.pid")
for _ in $(seq 1 60); do curl -sf "http://localhost:$WEB/api/health" >/dev/null 2>&1 && break; sleep 1; done
BASE_URL="http://localhost:$API" node scripts/phone-seed.mjs | tail -4
echo
echo "Speech: $MODE ($([ "$MODE" = fake ] && echo "put what you 'say' in .localdb/fake-stt.txt" || echo "base.en on this Mac"))"
echo "Open  http://localhost:$WEB   -> log in -> New Bill -> 'Speak the bill instead'   (Ctrl-C to stop)"
command -v open >/dev/null && open "http://localhost:$WEB" || true
while true; do sleep 3600; done
