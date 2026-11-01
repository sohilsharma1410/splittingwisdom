#!/usr/bin/env bash
# "Phone lab": the full app on a THROWAWAY database, reachable from your phone over
# two real HTTPS URLs (free Cloudflare quick tunnels, no account needed):
#   MAIN   plays the Pi          BACKUP plays Vercel+Render
# so you can test install-to-home-screen, camera, login, settling, failover and
# failback across genuinely separate origins before the Pi exists.
#
#   scripts/phone-test.sh            start everything (leave it running; Ctrl-C stops it)
#   scripts/phone-test.sh primary-down   simulate the Pi dying   (run in a 2nd terminal)
#   scripts/phone-test.sh primary-up     bring the "Pi" back
#   scripts/phone-test.sh status
#
# Uses fake data only. The URLs are random and temporary but public while this runs —
# don't put real data in it. Needs: brew install cloudflared postgresql@17 (qrencode optional).
set -euo pipefail
cd "$(dirname "$0")/.."
ROOT="$PWD"; PIDS="$ROOT/.localdb/pids"; mkdir -p "$PIDS"
CMD="${1:-up}"

pid_alive() { [ -f "$1" ] && kill -0 "$(cat "$1")" 2>/dev/null; }
read_url() { cat "$ROOT/.localdb/phone-$1.url" 2>/dev/null || true; }

case "$CMD" in
  primary-down)
    pid_alive "$PIDS/api-4100.pid" || { echo "main API is already down"; exit 0; }
    pkill -P "$(cat "$PIDS/api-4100.pid")" 2>/dev/null || true; kill "$(cat "$PIDS/api-4100.pid")" 2>/dev/null || true
    echo "MAIN server stopped (the 'Pi' is down). Open the app on your phone and watch it switch to BACKUP."; exit 0 ;;
  primary-up)
    "$ROOT/.localdb/start-api-4100.sh"; echo "MAIN server started again (the 'Pi' is back)."; exit 0 ;;
  status)
    for n in main backup; do u="$(read_url $n)"; printf "%-7s %s  -> " "$n" "${u:-<not running>}"; [ -n "$u" ] && curl -s -o /dev/null -w "%{http_code}\n" --max-time 8 "$u/api/health" || echo; done; exit 0 ;;
  up) ;;
  *) echo "usage: $0 [up|primary-down|primary-up|status]" >&2; exit 1 ;;
esac

started=()
cleanup() {
  echo; echo "Stopping phone lab..."
  for f in "${started[@]:-}"; do
    [ -n "$f" ] && [ -f "$f" ] && { pkill -P "$(cat "$f")" 2>/dev/null || true; kill "$(cat "$f")" 2>/dev/null || true; }
  done
  rm -f "$ROOT"/.localdb/phone-*.url
}
trap cleanup EXIT INT TERM

DB_URL="$(scripts/local-pg.sh main 54329 start)"
node scripts/link-drizzle-orm.mjs >/dev/null
echo "== database (throwaway)"; scripts/local-pg.sh main 54329 reset >/dev/null
(cd server && DATABASE_URL="$DB_URL" npx drizzle-kit migrate >/dev/null 2>&1)

start_api() {
  cat > "$ROOT/.localdb/start-api-$1.sh" <<SH
#!/usr/bin/env bash
cd "$ROOT/server"
DATABASE_URL="$DB_URL" SESSION_SECRET=phone-lab-secret PORT=$1 NODE_ENV=development \\
  nohup npx tsx src/index.ts > "$ROOT/.localdb/api-$1.log" 2>&1 &
echo \$! > "$PIDS/api-$1.pid"
SH
  chmod +x "$ROOT/.localdb/start-api-$1.sh"; "$ROOT/.localdb/start-api-$1.sh"; started+=("$PIDS/api-$1.pid")
}
wait_for() { for _ in $(seq 1 90); do curl -sf --max-time 5 "$1" >/dev/null 2>&1 && return 0; sleep 1; done; echo "timed out waiting for $1" >&2; return 1; }

echo "== servers"; start_api 4100; start_api 4101
wait_for http://localhost:4100/api/health; wait_for http://localhost:4101/api/health

start_tunnel() { # port name
  local log="$ROOT/.localdb/tunnel-$1.log"; : > "$log"
  nohup cloudflared tunnel --no-autoupdate --url "http://127.0.0.1:$1" > "$log" 2>&1 & echo $! > "$PIDS/tunnel-$1.pid"; started+=("$PIDS/tunnel-$1.pid")
  for _ in $(seq 1 60); do
    url="$(grep -o 'https://[a-z0-9-]*\.trycloudflare\.com' "$log" | head -1 || true)"
    [ -n "$url" ] && { echo "$url" > "$ROOT/.localdb/phone-$2.url"; return 0; }; sleep 1
  done
  echo "could not get a tunnel URL; see $log" >&2; return 1
}
echo "== public HTTPS URLs"; start_tunnel 4173 main; start_tunnel 4174 backup
MAIN="$(read_url main)"; BACKUP="$(read_url backup)"

echo "== building the app with those two URLs baked in (so each knows where the other lives)"
npm run build --workspace=shared >/dev/null
(cd client && VITE_PRIMARY_URL="$MAIN" VITE_STANDBY_URL="$BACKUP" npx vite build >/dev/null)
start_preview() { (cd client && PREVIEW_API_URL="$2" nohup npx vite preview --host 127.0.0.1 --port "$1" --strictPort > "$ROOT/.localdb/preview-$1.log" 2>&1 & echo $! > "$PIDS/preview-$1.pid"); started+=("$PIDS/preview-$1.pid"); }
start_preview 4173 http://localhost:4100; start_preview 4174 http://localhost:4101
wait_for "$MAIN/api/health"; wait_for "$BACKUP/api/health"
BASE_URL=http://localhost:4100 node scripts/phone-seed.mjs

cat <<MSG

==================== PHONE LAB IS UP ====================
  MAIN   (plays the Pi):          $MAIN
  BACKUP (plays Vercel+Render):   $BACKUP

Open MAIN on your phone. To simulate the Pi dying, run in another terminal:
    scripts/phone-test.sh primary-down        (and primary-up to bring it back)
Leave this window open; Ctrl-C stops everything and discards the data.
=========================================================
MSG
command -v qrencode >/dev/null && { echo "Scan to open MAIN:"; qrencode -t ANSIUTF8 "$MAIN"; }
while true; do sleep 3600; done
