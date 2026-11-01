#!/usr/bin/env bash
# Copies the app's data from Supabase into the Pi's empty database, then checks
# the copy (plan P4.1-P4.4, QA-4). Supabase is only ever read: pg_dump and the
# checker both run read-only, so users on the current app aren't affected.
#
# Asks for the Supabase SESSION pooler URL (port 5432 on *.pooler.supabase.com).
# The transaction pooler (6543) can't run pg_dump, and the direct db.* host is
# IPv6-only, which containers here don't have. The URL isn't stored anywhere.
set -euo pipefail
cd "$(dirname "$0")"

TABLES=(users groups group_members bills bill_items item_assignments settlements)
DUMP_DIR="$HOME/splittingwisdom-migration"
DUMP_FILE="data-$(date +%Y%m%d-%H%M%S).dump"

pi_sql() {
  docker compose exec -T postgres psql -U splittingwisdom -d splittingwisdom -v ON_ERROR_STOP=1 -qtA "$@"
}
fail() { echo "STOP: $1" >&2; exit 1; }

echo "== Checking the Pi is ready"
[ "$(docker compose ps --status running --services 2>/dev/null | grep -cE '^(postgres|api)$')" = 2 ] \
  || fail "the stack isn't running. Run: docker compose up -d"
if sudo tailscale funnel status 2>/dev/null | grep -qi 'funnel on'; then
  fail "Funnel is on, so people could log in to this copy and lose whatever they do in it. Run: sudo tailscale funnel reset"
fi
for table in "${TABLES[@]}"; do
  rows="$(pi_sql -c "SELECT count(*) FROM \"$table\"")"
  [ "$rows" = 0 ] || fail "$table already has $rows rows here. This script only fills an empty database. If nothing here matters, reset it with: docker compose down -v && docker compose up -d"
done

SOURCE_URL="${MIGRATION_SOURCE_URL:-}"
if [ -z "$SOURCE_URL" ]; then
  read -rsp "Supabase session pooler URL (hidden): " SOURCE_URL
  echo
fi
case "$SOURCE_URL" in
  postgres://*@*.pooler.supabase.com:5432/* | postgresql://*@*.pooler.supabase.com:5432/*) ;;
  *) fail "expected the session pooler URL: postgresql://postgres.<ref>:<password>@<region>.pooler.supabase.com:5432/postgres" ;;
esac
export MIGRATION_SOURCE_URL="$SOURCE_URL"

echo "== Dumping from Supabase (read-only)"
# The dump holds real user data, including password hashes: keep it private.
mkdir -p "$DUMP_DIR"
chmod 700 "$DUMP_DIR"
TABLE_ARGS=()
for table in "${TABLES[@]}"; do TABLE_ARGS+=(-t "public.$table"); done
docker run --rm --user "$(id -u):$(id -g)" \
  -e MIGRATION_SOURCE_URL -e PGSSLMODE=require -e PGCONNECT_TIMEOUT=30 \
  -v "$DUMP_DIR:/dump" postgres:17 \
  sh -c 'umask 077; exec pg_dump "$MIGRATION_SOURCE_URL" --data-only --no-owner --no-privileges -Fc -f "/dump/$0" "$@"' \
  "$DUMP_FILE" "${TABLE_ARGS[@]}"
echo "   saved $DUMP_DIR/$DUMP_FILE"

echo "== Restoring into the Pi"
# All or nothing. --disable-triggers keeps the copied rows out of the sync outbox
# and the deletion log, because they aren't changes made on this node. PGTZ=UTC
# matches how the old zone-less timestamps were written.
docker compose exec -T -e PGTZ=UTC postgres \
  pg_restore -U splittingwisdom -d splittingwisdom --data-only --disable-triggers --single-transaction --no-owner \
  < "$DUMP_DIR/$DUMP_FILE"

echo "== Moving id counters past the copied rows"
for table in "${TABLES[@]}"; do
  pi_sql -c "SELECT setval(pg_get_serial_sequence('public.\"$table\"', 'id'), COALESCE(MAX(id), 1), MAX(id) IS NOT NULL) FROM \"$table\"" >/dev/null
done

outbox="$(pi_sql -c 'SELECT (SELECT count(*) FROM sync_outbox) + (SELECT count(*) FROM deletion_log)')"
[ "$outbox" = 0 ] || fail "the restore queued $outbox sync events, but should have queued none."

echo "== Comparing the Pi with Supabase (QA-4)"
docker compose run --rm --no-deps -T -e MIGRATION_SOURCE_URL migrate node server/dist/tools/verify-migration.js

echo
echo "The copy matches. The dump is still at $DUMP_DIR/$DUMP_FILE"
