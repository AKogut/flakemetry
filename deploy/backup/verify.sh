#!/usr/bin/env sh
# Report what a Flakemetry database actually contains.
#
#   deploy/backup/verify.sh
#
# Run it before a backup and again after a restore. A dump that loaded without error and a
# dump that carried the data are not the same claim, and only counts distinguish them.
set -eu

COMPOSE="${FLAKEMETRY_COMPOSE:-docker compose}"
PG_SERVICE="${FLAKEMETRY_PG_SERVICE:-postgres}"
PG_USER="${POSTGRES_USER:-flakemetry}"
PG_DB="${POSTGRES_DB:-flakemetry}"

$COMPOSE exec -T "$PG_SERVICE" psql -U "$PG_USER" -d "$PG_DB" -t -A -F: -c "
  SELECT 'org', count(*) FROM org
  UNION ALL SELECT 'project', count(*) FROM project
  UNION ALL SELECT 'run', count(*) FROM run
  UNION ALL SELECT 'test_identity', count(*) FROM test_identity
  UNION ALL SELECT 'test_execution', count(*) FROM test_execution
  UNION ALL SELECT 'flaky_score', count(*) FROM flaky_score
  UNION ALL SELECT 'ingest_token', count(*) FROM ingest_token
  UNION ALL SELECT 'membership', count(*) FROM membership
  UNION ALL SELECT 'migrations', count(*) FROM _prisma_migrations WHERE finished_at IS NOT NULL
  ORDER BY 1
" | sed 's/^/  /'
