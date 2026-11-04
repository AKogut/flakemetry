ALTER TABLE "daily_test_stats"
  ADD COLUMN "duration_samples" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "first_attempt_runs" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "first_attempt_failed_runs" INTEGER NOT NULL DEFAULT 0;

ALTER TABLE "suite_daily"
  ADD COLUMN "duration_samples" INTEGER NOT NULL DEFAULT 0;

UPDATE "daily_test_stats" SET "duration_samples" = "total" WHERE "avg_duration_ms" > 0;

UPDATE "suite_daily" SET "duration_samples" = "total" WHERE "avg_duration_ms" > 0;

WITH timed AS (
  SELECT DISTINCT run_id, date_trunc('day', started_at)::date AS day
  FROM "test_execution"
  WHERE status <> 'skip' AND duration_ms > 0
)
UPDATE "daily_test_stats" AS s
SET "duration_samples" = agg.samples,
    "avg_duration_ms" = agg.avg_ms,
    "first_attempt_runs" = agg.runs,
    "first_attempt_failed_runs" = agg.failed_runs
FROM (
  SELECT e.test_identity_id,
         date_trunc('day', e.started_at)::date AS day,
         COUNT(*) FILTER (WHERE e.status <> 'skip' AND timed.run_id IS NOT NULL)::int AS samples,
         COALESCE(
           ROUND(AVG(e.duration_ms) FILTER (WHERE e.status <> 'skip' AND timed.run_id IS NOT NULL)),
           0
         )::int AS avg_ms,
         COUNT(DISTINCT e.run_id) FILTER (WHERE e.attempt = 1 AND e.status <> 'skip')::int AS runs,
         COUNT(DISTINCT e.run_id) FILTER (WHERE e.attempt = 1 AND e.status IN ('fail', 'flaky'))::int AS failed_runs
  FROM "test_execution" e
  LEFT JOIN timed
    ON timed.run_id = e.run_id AND timed.day = date_trunc('day', e.started_at)::date
  GROUP BY e.test_identity_id, date_trunc('day', e.started_at)::date
) AS agg
WHERE s.test_identity_id = agg.test_identity_id AND s.day = agg.day;

WITH timed AS (
  SELECT DISTINCT run_id, date_trunc('day', started_at)::date AS day
  FROM "test_execution"
  WHERE status <> 'skip' AND duration_ms > 0
)
UPDATE "suite_daily" AS s
SET "duration_samples" = agg.samples,
    "avg_duration_ms" = agg.avg_ms
FROM (
  SELECT e.project_id,
         i.suite,
         date_trunc('day', e.started_at)::date AS day,
         COUNT(*) FILTER (WHERE e.status <> 'skip' AND timed.run_id IS NOT NULL)::int AS samples,
         COALESCE(
           ROUND(AVG(e.duration_ms) FILTER (WHERE e.status <> 'skip' AND timed.run_id IS NOT NULL)),
           0
         )::int AS avg_ms
  FROM "test_execution" e
  JOIN "test_identity" i ON i.id = e.test_identity_id
  LEFT JOIN timed
    ON timed.run_id = e.run_id AND timed.day = date_trunc('day', e.started_at)::date
  GROUP BY e.project_id, i.suite, date_trunc('day', e.started_at)::date
) AS agg
WHERE s.project_id = agg.project_id AND s.suite = agg.suite AND s.day = agg.day;
