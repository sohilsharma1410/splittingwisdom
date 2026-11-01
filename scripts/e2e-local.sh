#!/usr/bin/env bash
# Stands up a complete throwaway local stack, runs the smoke test and every
# Playwright spec against it, then stops only what it started.
#
#   primary: API :4100 + client :4173      standby: API :4101 + client :4174
#   both APIs share one throwaway Postgres (scripts/local-pg.sh main 54329)
#
#   scripts/e2e-local.sh                 # everything
#   scripts/e2e-local.sh e2e/settlements.spec.ts   # just one spec
#
# Never touches the production database or any real deployment.
set -euo pipefail
cd "$(dirname "$0")/.."
ROOT="$PWD"
PIDS="$ROOT/.localdb/pids"
mkdir -p "$PIDS"

DB_URL="$(scripts/local-pg.sh main 54329 start)"
export DB_URL
started=()
cleanup() {
  for f in "${started[@]:-}"; do
    [ -n "$f" ] && [ -f "$f" ] && kill "$(cat "$f")" 2>/dev/null || true
    [ -n "$f" ] && pkill -P "$(cat "$f" 2>/dev/null || echo 0)" 2>/dev/null || true
  done
}
trap cleanup EXIT

node scripts/link-drizzle-orm.mjs >/dev/null
echo "== migrate"; (cd server && DATABASE_URL="$DB_URL" npx drizzle-kit migrate >/dev/null 2>&1)
echo "== build shared + client (failover URLs baked in)"
npm run build --workspace=shared >/dev/null
(cd client && VITE_PRIMARY_URL=http://localhost:4173 VITE_STANDBY_URL=http://127.0.0.1:4174 npx vite build >/dev/null)

start_api() { # port
  cat > "$ROOT/.localdb/start-api-$1.sh" <<SH
#!/usr/bin/env bash
cd "$ROOT/server"
DATABASE_URL="$DB_URL" SESSION_SECRET=local-test-secret PORT=$1 NODE_ENV=development \\
  nohup npx tsx src/index.ts > "$ROOT/.localdb/api-$1.log" 2>&1 &
echo \$! > "$PIDS/api-$1.pid"
SH
  chmod +x "$ROOT/.localdb/start-api-$1.sh"
  "$ROOT/.localdb/start-api-$1.sh"; started+=("$PIDS/api-$1.pid")
}
start_preview() { # port host api
  (cd client && PREVIEW_API_URL="$3" nohup npx vite preview --host "$2" --port "$1" --strictPort \
    > "$ROOT/.localdb/preview-$1.log" 2>&1 & echo $! > "$PIDS/preview-$1.pid"); started+=("$PIDS/preview-$1.pid")
}
wait_for() { for _ in $(seq 1 60); do curl -sf "$1" >/dev/null 2>&1 && return 0; sleep 0.5; done; echo "timed out waiting for $1" >&2; return 1; }

start_api 4100; start_api 4101
start_preview 4173 localhost http://localhost:4100
start_preview 4174 127.0.0.1 http://localhost:4101
wait_for http://localhost:4173/api/health; wait_for http://127.0.0.1:4174/api/health

echo "== API smoke (QA-1)"; BASE_URL=http://localhost:4100 node scripts/qa-smoke.mjs | tail -3
echo "== Playwright"
E2E_PRIMARY_URL=http://localhost:4173 E2E_STANDBY_URL=http://127.0.0.1:4174 \
E2E_PRIMARY_API_PIDFILE="$PIDS/api-4100.pid" E2E_PRIMARY_API_START="$ROOT/.localdb/start-api-4100.sh" \
  npx playwright test --timeout=45000 "$@"
