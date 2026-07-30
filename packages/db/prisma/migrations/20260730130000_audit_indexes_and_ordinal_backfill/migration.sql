-- CreateIndex
CREATE INDEX "run_project_id_ci_run_id_idx" ON "run"("project_id", "ci_run_id");

-- CreateIndex
CREATE INDEX "error_signature_project_id_last_seen_at_idx" ON "error_signature"("project_id", "last_seen_at" DESC);

-- Backfill deterministic execution ordinals for runs ingested before the
-- execution_ordinal feature, so reprocessing keeps stable execution identity
-- and does not cascade-delete their RCA reports.
WITH ranked AS (
  SELECT
    "id",
    ROW_NUMBER() OVER (PARTITION BY "run_id" ORDER BY "started_at", "id") - 1 AS rn
  FROM "test_execution"
  WHERE "run_id" IN (
    SELECT "run_id" FROM "test_execution" GROUP BY "run_id" HAVING count("ordinal") = 0
  )
)
UPDATE "test_execution" AS te
SET "ordinal" = ranked.rn
FROM ranked
WHERE te."id" = ranked."id";
