#!/usr/bin/env bash
# QA-1 on the Pi: the full API smoke test, then a check that a login survives
# restarting the whole stack. It registers throwaway qa-* users, so only run it
# on a database you're going to reset, or clean those users up afterwards.
set -euo pipefail
cd "$(dirname "$0")"
BASE_URL="${BASE_URL:-http://127.0.0.1:4000}"

wait_for_ocr() {
  for _ in $(seq 1 60); do
    [ "$(docker inspect -f '{{.State.Health.Status}}' "$(docker compose ps -q ocr)" 2>/dev/null)" = healthy ] && return 0
    sleep 2
  done
  echo "FAIL  the ocr container didn't become healthy"
  exit 1
}
wait_for_ocr

echo "== API smoke test"
docker run --rm --network host \
  -e BASE_URL="$BASE_URL" -e EXPECT_SERVED_CLIENT=1 -e EXPECT_LOCAL_RECEIPTS=1 -e EXPECT_LOCAL_OCR=1 \
  -v "$PWD/../../scripts:/qa:ro" \
  node:22-slim node /qa/qa-smoke.mjs

echo
echo "== Login survives a full restart"
RUN="$(od -An -N4 -tx1 /dev/urandom | tr -d ' \n')"
# The API is behind Funnel in production; this header says the same thing here.
COOKIE="$(curl -sS -D - -o /dev/null -X POST "$BASE_URL/api/auth/register" \
  -H 'Content-Type: application/json' -H 'X-Forwarded-Proto: https' -H "X-Forwarded-For: 10.99.0.$((RANDOM % 250))" \
  -d "{\"email\":\"qa-restart-$RUN@example.com\",\"displayName\":\"QA Restart\",\"password\":\"qa-password-123\"}" \
  | tr -d '\r' | sed -n 's/^[Ss]et-[Cc]ookie: \(connect\.sid=[^;]*\).*/\1/p')"
[ -n "$COOKIE" ] || { echo "FAIL  register returned no session cookie"; exit 1; }

docker compose restart
for _ in $(seq 1 60); do
  curl -sf -o /dev/null "$BASE_URL/api/health/db" && break
  sleep 2
done

STATUS="$(curl -sS -o /dev/null -w '%{http_code}' -H "Cookie: $COOKIE" "$BASE_URL/api/auth/me")"
if [ "$STATUS" = 200 ]; then
  echo "PASS  still logged in after the restart"
else
  echo "FAIL  /api/auth/me returned $STATUS after the restart"
  exit 1
fi

echo
echo "== OCR container is isolated"
wait_for_ocr
FAILED=0
pass_or_fail() {
  if [ "$2" = yes ]; then echo "PASS  $1"; else echo "FAIL  $1"; FAILED=1; fi
}
OCR_ID="$(docker compose ps -q ocr)"

# Proves commands run in there, so the two checks below can't pass just by failing to start.
docker compose exec -T ocr python -c "pass"

if docker compose exec -T ocr python -c "import urllib.request as u; u.urlopen('https://1.1.1.1', timeout=5)" >/dev/null 2>&1; then
  pass_or_fail "no internet from the ocr container" no
else
  pass_or_fail "no internet from the ocr container" yes
fi
if docker compose exec -T ocr python -c "import socket; socket.gethostbyname('postgres')" >/dev/null 2>&1; then
  pass_or_fail "the ocr container can't find Postgres" no
else
  pass_or_fail "the ocr container can't find Postgres" yes
fi
if curl -s -o /dev/null -m 2 http://127.0.0.1:8000/health; then
  pass_or_fail "no OCR port on the host" no
else
  pass_or_fail "no OCR port on the host" yes
fi
[ "$(docker inspect -f '{{.HostConfig.Memory}}' "$OCR_ID")" = 1572864000 ] \
  && pass_or_fail "memory limit is set (1500 MB)" yes || pass_or_fail "memory limit is set (1500 MB)" no
if docker info 2>&1 | grep -qi 'no memory limit support'; then
  pass_or_fail "the kernel enforces the memory limit" no
else
  pass_or_fail "the kernel enforces the memory limit" yes
fi

echo
echo "== The app keeps working with OCR down"
docker compose stop ocr >/dev/null 2>&1
SCAN="$(curl -sS -m 40 -H "Cookie: $COOKIE" -H "X-Forwarded-For: 10.99.1.$((RANDOM % 250))" \
  -F "image=@$PWD/../../scripts/fixtures/made-up-receipt.jpg;type=image/jpeg" "$BASE_URL/api/bills/extract")"
case "$SCAN" in
  *'"extractionFailed":true'*) pass_or_fail "a scan falls back to manual entry" yes ;;
  *) pass_or_fail "a scan falls back to manual entry" no ;;
esac
case "$SCAN" in
  *'"imagePath":"'*) pass_or_fail "the photo is still kept" yes ;;
  *) pass_or_fail "the photo is still kept" no ;;
esac
[ "$(curl -sS -o /dev/null -w '%{http_code}' "$BASE_URL/api/health/db")" = 200 ] \
  && pass_or_fail "the app and database are still healthy" yes || pass_or_fail "the app and database are still healthy" no
docker compose start ocr >/dev/null 2>&1
wait_for_ocr
pass_or_fail "the ocr container came back" yes

[ "$FAILED" = 0 ] || exit 1
