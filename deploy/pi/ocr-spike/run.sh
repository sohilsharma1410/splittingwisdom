#!/usr/bin/env bash
# OCR speed test (local OCR plan, step 1). The scans run with no network, so photos
# can't leave the Pi. Results go to ~/ocr-test-results.
#
#   ./run.sh public   downloads public sample receipts and also scores accuracy
#   ./run.sh          uses your own photos in ~/ocr-test
set -euo pipefail
cd "$(dirname "$0")"

MODE="${1:-own}"
RESULTS="${OCR_RESULTS:-$HOME/ocr-test-results}"
PUBLIC_DIR="${OCR_PUBLIC_DIR:-$HOME/ocr-test-public}"
ANSWERS_DIR="$PUBLIC_DIR-answers"
HEALTH_URL="${OCR_HEALTH_URL:-http://127.0.0.1:4000/api/health}"
IMAGE=splittingwisdom-ocr-spike:local

case "$MODE" in
  public) PHOTOS="$PUBLIC_DIR" ;;
  own) PHOTOS="${OCR_PHOTOS:-$HOME/ocr-test}" ;;
  *) echo "Usage: ./run.sh [public]" >&2; exit 2 ;;
esac

if [ "$MODE" = own ] && { [ ! -d "$PHOTOS" ] || [ -z "$(ls -A "$PHOTOS")" ]; }; then
  echo "STOP: no photos in $PHOTOS. To use public samples instead, run: ./run.sh public" >&2
  exit 1
fi

echo "== Building the test image (about 5 minutes the first time)"
docker build -q -t "$IMAGE" . >/dev/null

if [ "$MODE" = public ] && [ ! -s "$ANSWERS_DIR/answers.json" ]; then
  echo "== Downloading public sample receipts"
  rm -rf "$PUBLIC_DIR"
  mkdir -p "$PUBLIC_DIR" "$ANSWERS_DIR"
  docker run --rm --read-only --tmpfs /tmp --user "$(id -u):$(id -g)" \
    -v "$PUBLIC_DIR:/photos" -v "$ANSWERS_DIR:/answers" \
    "$IMAGE" python fetch_samples.py /photos /answers/answers.json
fi

rm -rf "$RESULTS"
mkdir -p "$RESULTS"
chmod 700 "$RESULTS"

# Checks once a second whether the app still answers quickly during a scan.
watch_app() {
  while :; do
    curl -s -o /dev/null -m 10 -w '%{http_code} %{time_total}\n' "$HEALTH_URL" || echo "000 10"
    sleep 1
  done
}

for model in tiny small; do
  HEALTH_LOG="$(mktemp)"
  watch_app >"$HEALTH_LOG" &
  WATCHER=$!

  status=0
  docker run --rm --network none --read-only --tmpfs /tmp \
    --cpuset-cpus 0-2 \
    --user "$(id -u):$(id -g)" \
    -v "$PHOTOS:/photos:ro" -v "$RESULTS:/results" \
    "$IMAGE" python spike.py "$model" /photos /results || status=$?

  kill "$WATCHER" 2>/dev/null || true
  wait "$WATCHER" 2>/dev/null || true

  [ "$status" = 0 ] || echo "Result: failed with exit code $status"

  awk '
    $1 == 200 { n++; if ($2 > worst) worst = $2 }
    $1 != 200 { failed++ }
    END {
      if (n == 0) { print "App during the scans: not measured (is the stack running?)"; exit }
      printf "App during the scans: %d checks, slowest %.2fs, %d failed\n", n + failed, worst, failed
    }' "$HEALTH_LOG"
  rm -f "$HEALTH_LOG"
done

if [ "$MODE" = public ]; then
  docker run --rm --network none --read-only --tmpfs /tmp --user "$(id -u):$(id -g)" \
    -v "$RESULTS:/results:ro" -v "$ANSWERS_DIR:/answers:ro" \
    "$IMAGE" python score.py /results /answers/answers.json
fi

echo
echo "The text is in $RESULTS, with masked copies in share-tiny.txt and share-small.txt."
[ "$MODE" = public ] || echo "Check them for names and anything else private before sharing."
