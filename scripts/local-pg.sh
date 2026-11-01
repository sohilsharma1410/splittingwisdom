#!/usr/bin/env bash
# Isolated throwaway Postgres 17 clusters for local dev/testing — never the
# production Supabase DB. Each cluster lives in .localdb/<name>/ (gitignored),
# listens only on 127.0.0.1, and has SSL on (self-signed) because the server
# currently connects with ssl enabled (see server/src/session.ts).
#
#   scripts/local-pg.sh <name> <port> start|stop|reset|status|url|psql
#
# Example: scripts/local-pg.sh main 54329 start
set -euo pipefail

NAME="${1:?usage: local-pg.sh <name> <port> start|stop|reset|status|url|psql}"
PORT="${2:?port required}"
CMD="${3:?command required}"

export LC_ALL="${LC_ALL:-en_US.UTF-8}"
PG_BIN="${PG_BIN:-/opt/homebrew/opt/postgresql@17/bin}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DATA="$ROOT/.localdb/$NAME"
DB="splittingwisdom"
URL="postgres://postgres@127.0.0.1:$PORT/$DB"

init() {
  [ -d "$DATA" ] && return
  mkdir -p "$DATA"
  "$PG_BIN/initdb" -D "$DATA" -U postgres --auth=trust --encoding=UTF8 >/dev/null
  openssl req -new -x509 -days 3650 -nodes -subj "/CN=localhost" \
    -out "$DATA/server.crt" -keyout "$DATA/server.key" 2>/dev/null
  chmod 600 "$DATA/server.key"
  cat >> "$DATA/postgresql.conf" <<EOF
port = $PORT
listen_addresses = '127.0.0.1'
unix_socket_directories = ''
ssl = on
ssl_cert_file = 'server.crt'
ssl_key_file = 'server.key'
wal_level = logical
EOF
}

running() { "$PG_BIN/pg_ctl" -D "$DATA" status >/dev/null 2>&1; }

case "$CMD" in
  start)
    init
    running || "$PG_BIN/pg_ctl" -D "$DATA" -l "$DATA/server.log" -w start >/dev/null
    "$PG_BIN/psql" -h 127.0.0.1 -p "$PORT" -U postgres -tAc \
      "SELECT 1 FROM pg_database WHERE datname='$DB'" postgres | grep -q 1 \
      || "$PG_BIN/createdb" -h 127.0.0.1 -p "$PORT" -U postgres "$DB"
    echo "$URL"
    ;;
  stop)   running && "$PG_BIN/pg_ctl" -D "$DATA" -m fast stop >/dev/null || true ;;
  reset)  running && "$PG_BIN/pg_ctl" -D "$DATA" -m immediate stop >/dev/null || true
          rm -rf "$DATA"; "$0" "$NAME" "$PORT" start ;;
  status) running && echo "running on $PORT" || echo "stopped" ;;
  url)    echo "$URL" ;;
  psql)   exec "$PG_BIN/psql" "$URL" ;;
  *) echo "unknown command: $CMD" >&2; exit 1 ;;
esac
