#!/usr/bin/env bash
# Speech-to-text speed test for the Pi (plan D4.9). Everything runs with no network, using
# public and generated clips copied from a computer. Results go to ~/stt-test-results.
# Takes about 30 minutes, plus about 5 to build the image the first time.
set -euo pipefail
cd "$(dirname "$0")"

SAMPLES="${STT_SAMPLES:-$HOME/stt-test-public}"
RESULTS="${STT_RESULTS:-$HOME/stt-test-results}"
HEALTH_URL="${STT_HEALTH_URL:-http://127.0.0.1:4000/api/health/db}"
IMAGE=splittingwisdom-stt-spike:local
COMPOSE=(docker compose -f ../docker-compose.yml)

if [ ! -s "$SAMPLES/answers.json" ]; then
  echo "STOP: no test clips in $SAMPLES. Copy them from your computer first." >&2
  exit 1
fi

echo "== Building the test image (about 5 minutes the first time)"
docker build -q -t "$IMAGE" . >/dev/null

rm -rf "$RESULTS"
mkdir -p "$RESULTS"

# Same limits the real container would have.
stt() {
  docker run --rm --network none --read-only --tmpfs /tmp \
    --cap-drop ALL --security-opt no-new-privileges \
    --cpuset-cpus 0-2 --memory 1500m --memory-swap 1500m \
    --user "$(id -u):$(id -g)" \
    -e STT_NO_RETRY="${STT_NO_RETRY:-}" \
    -v "$SAMPLES:/samples:ro" -v "$RESULTS:/results" \
    "$IMAGE" "$@"
}

# Checks once a second that the app and its database still answer quickly.
watch_app() {
  while :; do
    curl -s -o /dev/null -m 10 -w '%{http_code} %{time_total}\n' "$HEALTH_URL" || echo "000 10"
    sleep 1
  done
}

report_app() {
  awk -v label="$2" '
    $1 == 200 { n++; if ($2 > worst) worst = $2 }
    $1 != 200 { failed++ }
    END {
      if (n == 0) { print "App " label ": not measured (is the stack running?)"; exit }
      printf "App %s: %d checks, slowest %.2fs, %d failed\n", label, n + failed, worst, failed
    }' "$1"
}

measured_run() {
  local log status=0
  log="$(mktemp)"
  watch_app >"$log" &
  local watcher=$!
  stt python spike.py "$@" || status=$?
  kill "$watcher" 2>/dev/null || true
  wait "$watcher" 2>/dev/null || true
  [ "$status" = 0 ] || echo "Result: failed with exit code $status"
  report_app "$log" "during that run"
  rm -f "$log"
}

echo
echo "== Speech only"
measured_run tiny-alone tiny.en prompt 1 /samples /results
measured_run base-alone base.en prompt 1 /samples /results
STT_NO_RETRY=1 measured_run base-no-retry base.en prompt 1 /samples /results real,real-noisy,split-long,split-noisy,empty

# Repeats a scan inside the OCR container until told to stop, with a safety limit.
OCR_LOOP='
import os, statistics, sys, time, urllib.request
image = sys.stdin.buffer.read()
times, deadline = [], time.time() + 1500
while time.time() < deadline and not os.path.exists("/tmp/stop-scan-loop"):
    started = time.time()
    urllib.request.urlopen(urllib.request.Request("http://127.0.0.1:8000/ocr", data=image), timeout=120).read()
    times.append(time.time() - started)
if os.path.exists("/tmp/stop-scan-loop"):
    os.remove("/tmp/stop-scan-loop")
print(f"Scans during speech: {len(times)}, typical {statistics.median(times):.1f}s, slowest {max(times):.1f}s")
'

busy_run() {
  local scans
  scans="$(mktemp)"
  "${COMPOSE[@]}" exec -T ocr python -c "$OCR_LOOP" <../../../scripts/fixtures/made-up-receipt.jpg >"$scans" &
  local loop=$!
  sleep 5
  measured_run "$@"
  "${COMPOSE[@]}" exec -T ocr python -c 'open("/tmp/stop-scan-loop", "w").close()'
  wait "$loop" || echo "The scan loop failed."
  cat "$scans"
  rm -f "$scans"
}

echo
echo "== Speech during receipt scans (the worst case)"
if [ "$("${COMPOSE[@]}" ps --status running -q ocr | wc -l)" = 1 ]; then
  busy_run tiny-during-scans tiny.en prompt 1 /samples /results real-long,split-long
  busy_run base-during-scans base.en prompt 1 /samples /results real-long,split-long
else
  echo "Skipped: the ocr container isn't running. Start the stack and run this again."
fi

echo
echo "== Accuracy"
stt python score.py /samples /results
echo
echo "Done. Send me everything printed above. Transcripts are in $RESULTS."
