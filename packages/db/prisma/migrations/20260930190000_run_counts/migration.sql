ALTER TABLE "run" ADD COLUMN "passed_count" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN "failed_count" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN "skipped_count" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN "flaky_count" INTEGER NOT NULL DEFAULT 0;

UPDATE "run"
SET "passed_count" = counts.passed,
    "failed_count" = counts.failed,
    "skipped_count" = counts.skipped,
    "flaky_count" = counts.flaky
FROM (
  SELECT "run_id",
         count(*) FILTER (WHERE "status" = 'pass') AS passed,
         count(*) FILTER (WHERE "status" = 'fail') AS failed,
         count(*) FILTER (WHERE "status" = 'skip') AS skipped,
         count(*) FILTER (WHERE "status" = 'flaky') AS flaky
  FROM "test_execution"
  GROUP BY "run_id"
) AS counts
WHERE "run"."id" = counts."run_id";
