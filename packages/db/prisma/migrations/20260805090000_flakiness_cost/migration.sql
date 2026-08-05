-- Retry wall-clock is the one part of the cost of flakiness that is measured rather than
-- assumed: an attempt beyond the first exists only because an earlier one failed. Storing it
-- on the rollups keeps it available after raw executions are pruned by retention.
ALTER TABLE "daily_test_stats"
  ADD COLUMN IF NOT EXISTS "rerun_count" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "rerun_ms" INTEGER NOT NULL DEFAULT 0;

ALTER TABLE "suite_daily"
  ADD COLUMN IF NOT EXISTS "rerun_count" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "rerun_ms" INTEGER NOT NULL DEFAULT 0;

-- Rates are per project because one instance can hold several, and a browser suite on
-- larger runners does not cost what a unit suite costs. NULL means inherit, like every
-- other policy column.
ALTER TABLE "project_policy"
  ADD COLUMN IF NOT EXISTS "ci_minute_cost" DOUBLE PRECISION,
  ADD COLUMN IF NOT EXISTS "developer_hour_cost" DOUBLE PRECISION,
  ADD COLUMN IF NOT EXISTS "investigation_minutes" INTEGER;

-- Backfill what is already ingested, so the panel is not empty on day one for anyone who
-- has been running Flakemetry. Executions older than retention are gone and cannot be
-- recovered, which is why this is a one-time best effort rather than the source of truth.
UPDATE "daily_test_stats" AS s
SET "rerun_count" = agg.count, "rerun_ms" = agg.ms
FROM (
  SELECT test_identity_id,
         date_trunc('day', started_at)::date AS day,
         COUNT(*)::int AS count,
         LEAST(COALESCE(SUM(duration_ms), 0), 2147483647)::int AS ms
  FROM "test_execution"
  WHERE attempt > 1
  GROUP BY test_identity_id, date_trunc('day', started_at)::date
) AS agg
WHERE s.test_identity_id = agg.test_identity_id AND s.day = agg.day;

UPDATE "suite_daily" AS s
SET "rerun_count" = agg.count, "rerun_ms" = agg.ms
FROM (
  SELECT e.project_id,
         i.suite,
         date_trunc('day', e.started_at)::date AS day,
         COUNT(*)::int AS count,
         LEAST(COALESCE(SUM(e.duration_ms), 0), 2147483647)::int AS ms
  FROM "test_execution" e
  JOIN "test_identity" i ON i.id = e.test_identity_id
  WHERE e.attempt > 1
  GROUP BY e.project_id, i.suite, date_trunc('day', e.started_at)::date
) AS agg
WHERE s.project_id = agg.project_id AND s.suite = agg.suite AND s.day = agg.day;
