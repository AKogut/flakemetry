ALTER TABLE "run" ADD COLUMN "stored_executions" INTEGER NOT NULL DEFAULT 0;

UPDATE "run"
SET "stored_executions" = counts.stored
FROM (
  SELECT "run_id", count(*) AS stored
  FROM "test_execution"
  GROUP BY "run_id"
) AS counts
WHERE "run"."id" = counts."run_id";
