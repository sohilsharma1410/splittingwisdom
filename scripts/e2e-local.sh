#!/usr/bin/env bash
# Stands up a complete throwaway local stack, runs the smoke test and every
# Playwright spec against it, then stops only what it started.
#
#   primary: API :4200 + client :4273      standby: API :4201 + client :4274  (separate from the phone lab on 4100-4174)
#   both APIs share one throwaway Postgres (scripts/local-pg.sh e2e 54340)
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

DB_URL="$(scripts/local-pg.sh e2e 54340 start)"
export DB_URL
started=()
cleanup() {
  for f in "${started[@]:-}"; do
    # Children first: killing the npm wrapper first would orphan the real server process.
    [ -n "$f" ] && [ -f "$f" ] && { pkill -P "$(cat "$f")" 2>/dev/null || true; kill "$(cat "$f")" 2>/dev/null || true; }
  done
}
trap cleanup EXIT

node scripts/link-drizzle-orm.mjs >/dev/null
echo "== migrate"; (cd server && DATABASE_URL="$DB_URL" npx drizzle-kit migrate >/dev/null 2>&1)
echo "== build shared + client (failover URLs baked in)"
npm run build --workspace=shared >/dev/null
(cd client && VITE_PRIMARY_URL=http://localhost:4273 VITE_STANDBY_URL=http://127.0.0.1:4274 npx vite build >/dev/null)

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

start_api 4200; start_api 4201
start_preview 4273 localhost http://localhost:4200
start_preview 4274 127.0.0.1 http://localhost:4201
wait_for http://localhost:4273/api/health; wait_for http://127.0.0.1:4274/api/health

echo "== API smoke (QA-1)"; BASE_URL=http://localhost:4200 node scripts/qa-smoke.mjs | tail -3
echo "== Playwright"
E2E_PRIMARY_URL=http://localhost:4273 E2E_STANDBY_URL=http://127.0.0.1:4274 \
E2E_PRIMARY_API_PIDFILE="$PIDS/api-4200.pid" E2E_PRIMARY_API_START="$ROOT/.localdb/start-api-4200.sh" \
  npx playwright test --timeout=45000 "$@"
