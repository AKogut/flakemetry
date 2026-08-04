CREATE TABLE "error_cluster" (
    "id" UUID NOT NULL,
    "org_id" UUID NOT NULL,
    "project_id" UUID NOT NULL,
    "label" TEXT NOT NULL,
    "signature_count" INTEGER NOT NULL DEFAULT 0,
    "occurrence_count" INTEGER NOT NULL DEFAULT 0,
    "known_issue_ref" TEXT,
    "first_seen_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_seen_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "error_cluster_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "error_cluster_org_id_idx" ON "error_cluster"("org_id");
CREATE INDEX "error_cluster_project_id_last_seen_at_idx" ON "error_cluster"("project_id", "last_seen_at" DESC);

ALTER TABLE "error_cluster" ADD CONSTRAINT "error_cluster_project_id_fkey"
    FOREIGN KEY ("project_id") REFERENCES "project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Cluster ids already exist on error_signature but point at no row: they were bare
-- uuids. Give each one the cluster it always implied so the new foreign key holds
-- and no existing grouping is lost.
WITH aggregated AS (
    SELECT
        cluster_id,
        count(*)::int AS signature_count,
        sum(occurrence_count)::int AS occurrence_count,
        min(first_seen_at) AS first_seen_at,
        max(last_seen_at) AS last_seen_at
    FROM "error_signature"
    WHERE cluster_id IS NOT NULL
    GROUP BY cluster_id
), representative AS (
    -- Tenant and label both come from the busiest signature in the cluster. Postgres
    -- has no min()/max() aggregate for uuid before 18, so org and project cannot be
    -- aggregated; taking them from one chosen row is also the more honest answer.
    SELECT DISTINCT ON (cluster_id)
        cluster_id,
        org_id,
        project_id,
        left(sample_message, 200) AS label
    FROM "error_signature"
    WHERE cluster_id IS NOT NULL
    ORDER BY cluster_id, occurrence_count DESC, last_seen_at DESC
)
INSERT INTO "error_cluster" (
    "id", "org_id", "project_id", "label",
    "signature_count", "occurrence_count", "first_seen_at", "last_seen_at"
)
SELECT
    aggregated.cluster_id,
    representative.org_id,
    representative.project_id,
    representative.label,
    aggregated.signature_count,
    aggregated.occurrence_count,
    aggregated.first_seen_at,
    aggregated.last_seen_at
FROM aggregated
JOIN representative ON representative.cluster_id = aggregated.cluster_id;

ALTER TABLE "error_signature" ADD COLUMN "tokens" TEXT[] NOT NULL DEFAULT '{}';

-- Candidate lookup narrows on token overlap, so a signature with no tokens can never
-- be matched. Seed existing rows here rather than leaving them invisible until the
-- backfill command runs; that command recomputes them with the canonical tokenizer.
UPDATE "error_signature"
SET tokens = ARRAY(
    SELECT DISTINCT token
    FROM unnest(
        regexp_split_to_array(
            regexp_replace(
                regexp_replace(
                    regexp_replace(
                        lower(coalesce(sample_message, '') || ' ' || coalesce(stack_template, '')),
                        '0x[0-9a-f]+', ' ', 'g'
                    ),
                    '[0-9a-f]{8,}', ' ', 'g'
                ),
                '[0-9]+', ' ', 'g'
            ),
            '[^a-z]+'
        )
    ) AS token
    WHERE length(token) >= 3
);

CREATE INDEX "error_signature_tokens_idx" ON "error_signature" USING GIN ("tokens");

ALTER TABLE "error_signature" ADD CONSTRAINT "error_signature_cluster_id_fkey"
    FOREIGN KEY ("cluster_id") REFERENCES "error_cluster"("id") ON DELETE SET NULL ON UPDATE CASCADE;
