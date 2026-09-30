#!/usr/bin/env sh
# Take a consistent backup of a Flakemetry instance.
#
#   deploy/backup/backup.sh [destination-directory]
#
# Postgres is the system of record: the queue, every run, identity and score. Artifacts are
# mirrored too when object storage is configured, but they are the recoverable half — losing
# them costs screenshots, not intelligence.
set -eu

DEST="${1:-./backups}"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
COMPOSE="${FLAKEMETRY_COMPOSE:-docker compose}"
PG_SERVICE="${FLAKEMETRY_PG_SERVICE:-postgres}"
PG_USER="${POSTGRES_USER:-flakemetry}"
PG_DB="${POSTGRES_DB:-flakemetry}"

mkdir -p "$DEST"
DUMP="$DEST/flakemetry-$STAMP.dump"

# Custom format, not plain SQL: it restores selectively, in parallel, and refuses to load
# into a schema it does not match — a plain dump will happily half-apply.
$COMPOSE exec -T "$PG_SERVICE" pg_dump -U "$PG_USER" -d "$PG_DB" --format=custom --no-owner \
  > "$DUMP"

SIZE="$(wc -c < "$DUMP" | tr -d ' ')"
if [ "$SIZE" -lt 1000 ]; then
  echo "backup: refusing a $SIZE byte dump — pg_dump did not produce a database" >&2
  rm -f "$DUMP"
  exit 1
fi

echo "backup: wrote $DUMP ($SIZE bytes)"

if [ -n "${FLAKEMETRY_BACKUP_MIRROR:-}" ]; then
  MC_SERVICE="${FLAKEMETRY_MC_SERVICE:-createbuckets}"
  BUCKET="${FLAKEMETRY_S3_BUCKET:-${S3_BUCKET:-flakemetry-artifacts}}"
  mkdir -p "$FLAKEMETRY_BACKUP_MIRROR"
  MIRROR="$(cd "$FLAKEMETRY_BACKUP_MIRROR" && pwd)"
  echo "backup: mirroring artifacts from $BUCKET to $MIRROR"
  $COMPOSE run --rm -T -v "$MIRROR:/mirror" -e "S3_BUCKET=$BUCKET" --entrypoint /bin/sh \
    "$MC_SERVICE" -c \
    'mc alias set local http://minio:9000 "$MINIO_ROOT_USER" "$MINIO_ROOT_PASSWORD" >/dev/null &&
     mc mirror --overwrite "local/$S3_BUCKET" /mirror'
fi

# Rotation is deliberate rather than infinite: a disk that fills is an outage, and the
# oldest dump is the least useful thing on it.
KEEP="${FLAKEMETRY_BACKUP_KEEP:-14}"
ls -1t "$DEST"/flakemetry-*.dump 2>/dev/null | tail -n "+$((KEEP + 1))" | while read -r old; do
  echo "backup: rotating out $old"
  rm -f "$old"
done
