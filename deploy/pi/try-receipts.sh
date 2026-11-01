#!/usr/bin/env bash
# Runs the photos in ~/ocr-test through the real scan flow and prints what was read
# (plan D3.3). Stays on the Pi: nothing goes through Funnel or any outside service.
#
# Registers a throwaway qa-ocr-* user, and each photo is stored in the receipts volume,
# as a real scan would be. The limit is 10 scans per user per hour, and each run uses a
# new user. The output shows what's on the receipts, so check it before sharing.
set -euo pipefail
cd "$(dirname "$0")"
BASE_URL="${BASE_URL:-http://127.0.0.1:4000}"
PHOTOS="${OCR_PHOTOS:-$HOME/ocr-test}"

[ -d "$PHOTOS" ] && [ -n "$(ls -A "$PHOTOS")" ] || { echo "STOP: no photos in $PHOTOS" >&2; exit 1; }

RUN="$(od -An -N4 -tx1 /dev/urandom | tr -d ' \n')"
export OCR_EMAIL="qa-ocr-$RUN@example.com"
export OCR_PASSWORD="qa-password-$RUN"
curl -sSf -o /dev/null -X POST "$BASE_URL/api/auth/register" \
  -H 'Content-Type: application/json' -H 'X-Forwarded-Proto: https' \
  -d "{\"email\":\"$OCR_EMAIL\",\"displayName\":\"QA OCR\",\"password\":\"$OCR_PASSWORD\"}"

docker run --rm --network host -e OCR_EMAIL -e OCR_PASSWORD \
  -v "$PWD/../../scripts:/qa:ro" -v "$PHOTOS:/photos:ro" \
  node:22-slim sh -c 'node /qa/ocr-test.mjs "$0" /photos/*' "$BASE_URL"
