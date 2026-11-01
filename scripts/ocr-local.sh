#!/usr/bin/env bash
# Try receipt OCR entirely on this Mac — no Pi, no Supabase, no tunnel.
#   scripts/ocr-local.sh receipt1.jpg [receipt2.jpg ...]
# Uses a throwaway database and stores photos in .localdb/receipts (STORAGE_DRIVER=local).
# GEMINI_API_KEY (and optionally GEMINI_MODEL) come from server/.env, never printed.
set -euo pipefail
cd "$(dirname "$0")/.."
ROOT="$PWD"; PORT=4400
[ $# -ge 1 ] || { echo "usage: $0 <receipt image> [more images]"; exit 1; }
for f in "$@"; do [ -f "$f" ] || { echo "not found: $f"; exit 1; }; done

DB_URL="$(scripts/local-pg.sh ocr 54360 start)"
node scripts/link-drizzle-orm.mjs >/dev/null
(cd server && DATABASE_URL="$DB_URL" npx drizzle-kit migrate >/dev/null 2>&1)
mkdir -p "$ROOT/.localdb/receipts"

(cd server && DATABASE_URL="$DB_URL" SESSION_SECRET=ocr-local PORT=$PORT NODE_ENV=development \
  STORAGE_DRIVER=local RECEIPTS_DIR="$ROOT/.localdb/receipts" \
  nohup npx tsx src/index.ts > "$ROOT/.localdb/api-ocr.log" 2>&1 & echo $! > "$ROOT/.localdb/pids/api-ocr.pid")
cleanup() { P=$(cat "$ROOT/.localdb/pids/api-ocr.pid" 2>/dev/null || echo 0); pkill -P "$P" 2>/dev/null || true; kill "$P" 2>/dev/null || true; scripts/local-pg.sh ocr 54360 stop; }
trap cleanup EXIT
for _ in $(seq 1 60); do curl -sf "http://localhost:$PORT/api/health" >/dev/null 2>&1 && break; sleep 1; done

EMAIL="ocr-$(date +%s)@example.com"; PASS="ocr-local-pass-1"
curl -sf -o /dev/null -X POST "http://localhost:$PORT/api/auth/register" -H 'Content-Type: application/json' -H 'X-Forwarded-For: 10.50.0.1' \
  -d "{\"email\":\"$EMAIL\",\"displayName\":\"OCR Tester\",\"password\":\"$PASS\"}"
OCR_EMAIL="$EMAIL" OCR_PASSWORD="$PASS" node scripts/ocr-test.mjs "http://localhost:$PORT" "$@"
echo; echo "Server log lines about Gemini (reason for any failure):"; grep -i "gemini" "$ROOT/.localdb/api-ocr.log" || echo "  (none — no errors)"
echo "Photos kept in .localdb/receipts: $(ls "$ROOT/.localdb/receipts"/* 2>/dev/null | wc -l | tr -d ' ') file(s)"
