#!/usr/bin/env bash
# QA-1 on the Pi: the full API smoke test, then a check that a login survives
# restarting the whole stack. It registers throwaway qa-* users, so only run it
# on a database you're going to reset, or clean those users up afterwards.
set -euo pipefail
cd "$(dirname "$0")"
BASE_URL="${BASE_URL:-http://127.0.0.1:4000}"

echo "== API smoke test"
docker run --rm --network host \
  -e BASE_URL="$BASE_URL" -e EXPECT_SERVED_CLIENT=1 -e EXPECT_LOCAL_RECEIPTS=1 \
  -v "$PWD/../../scripts/qa-smoke.mjs:/qa-smoke.mjs:ro" \
  node:22-slim node /qa-smoke.mjs

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
