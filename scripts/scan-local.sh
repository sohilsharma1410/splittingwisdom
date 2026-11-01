#!/usr/bin/env bash
# Try the receipt scan screen on this Mac, in your own browser — no Pi, no tunnel, no Supabase.
#
#   scripts/scan-local.sh                       # reads receipts with Gemini (key from server/.env)
#   OCR_PROVIDER=ollama OCR_MODEL=qwen2.5vl:7b scripts/scan-local.sh      # a model running on this Mac
#   OCR_PROVIDER=ollama OCR_MODEL=fake-vision OCR_BASE_URL=http://127.0.0.1:4290/v1 scripts/scan-local.sh   # canned demo (start scripts/fake-vision-model.mjs first)
#
# Opens http://localhost:4473 with demo users (password demo-pass-123) and a group "Goa trip (demo)".
# Throwaway database; photos go to .localdb/receipts. Ctrl-C stops everything.
set -euo pipefail
cd "$(dirname "$0")/.."
ROOT="$PWD"; PIDS="$ROOT/.localdb/pids"; mkdir -p "$PIDS" "$ROOT/.localdb/receipts"
API=4400; WEB=4473

DB_URL="$(scripts/local-pg.sh scan 54370 start)"
node scripts/link-drizzle-orm.mjs >/dev/null
scripts/local-pg.sh scan 54370 reset >/dev/null
(cd server && DATABASE_URL="$DB_URL" npx drizzle-kit migrate >/dev/null 2>&1)

started=()
cleanup() { for f in "${started[@]:-}"; do [ -f "$f" ] && { pkill -P "$(cat "$f")" 2>/dev/null || true; kill "$(cat "$f")" 2>/dev/null || true; }; done; scripts/local-pg.sh scan 54370 stop; }
trap cleanup EXIT INT TERM

(cd server && DATABASE_URL="$DB_URL" SESSION_SECRET=scan-local PORT=$API NODE_ENV=development STORAGE_DRIVER=local RECEIPTS_DIR="$ROOT/.localdb/receipts" \
  nohup npx tsx src/index.ts > "$ROOT/.localdb/api-scan.log" 2>&1 & echo $! > "$PIDS/api-scan.pid"); started+=("$PIDS/api-scan.pid")
npm run build --workspace=shared >/dev/null
(cd client && npx vite build >/dev/null)
(cd client && PREVIEW_API_URL="http://localhost:$API" nohup npx vite preview --host localhost --port $WEB --strictPort > "$ROOT/.localdb/web-scan.log" 2>&1 & echo $! > "$PIDS/web-scan.pid"); started+=("$PIDS/web-scan.pid")
for _ in $(seq 1 60); do curl -sf "http://localhost:$WEB/api/health" >/dev/null 2>&1 && break; sleep 1; done
BASE_URL="http://localhost:$API" node scripts/phone-seed.mjs | tail -4
echo; curl -s "http://localhost:$API/api/health" >/dev/null && echo "Reading receipts with: ${OCR_PROVIDER:-gemini} / ${OCR_MODEL:-${GEMINI_MODEL:-(default Gemini model)}}"
echo "Open  http://localhost:$WEB   -> log in -> New Bill -> 'Scan a receipt instead'   (Ctrl-C to stop)"
command -v open >/dev/null && open "http://localhost:$WEB" || true
while true; do sleep 3600; done
