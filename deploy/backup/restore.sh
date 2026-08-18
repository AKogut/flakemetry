#!/usr/bin/env sh
# Restore a Flakemetry instance from a dump taken by backup.sh.
#
#   deploy/backup/restore.sh ./backups/flakemetry-20260818T101500Z.dump
#
# This DROPS the current contents of the database. It is the recovery path, not a merge.
set -eu

DUMP="${1:?usage: restore.sh <dump-file>}"
COMPOSE="${FLAKEMETRY_COMPOSE:-docker compose}"
PG_SERVICE="${FLAKEMETRY_PG_SERVICE:-postgres}"
PG_USER="${POSTGRES_USER:-flakemetry}"
PG_DB="${POSTGRES_DB:-flakemetry}"

[ -f "$DUMP" ] || { echo "restore: no such dump: $DUMP" >&2; exit 1; }

# The api and worker hold connections and would write into a database being replaced under
# them. Postgres itself stays up — it is the thing being restored into.
echo "restore: stopping the services that write"
$COMPOSE stop api worker web >/dev/null 2>&1 || true

# `--clean --if-exists` inside a single transaction: either the whole database is replaced
# or nothing is. Half a restore is worse than no restore, because it looks like it worked.
echo "restore: loading $DUMP"
$COMPOSE exec -T "$PG_SERVICE" pg_restore -U "$PG_USER" -d "$PG_DB" \
  --clean --if-exists --no-owner --single-transaction < "$DUMP"

echo "restore: starting the services again"
$COMPOSE start api worker web >/dev/null 2>&1 || $COMPOSE up -d api worker web >/dev/null

echo "restore: done — verify with deploy/backup/verify.sh"
