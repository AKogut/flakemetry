DO $$ BEGIN
  CREATE TYPE "DataRequestKind" AS ENUM ('export', 'erasure');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE "DataRequestStatus" AS ENUM ('pending', 'running', 'completed', 'failed');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- No foreign keys, on purpose. This table records that a tenant was erased, so a cascade
-- from that tenant would take the record with it and leave nothing to show the erasure
-- happened. The subject name and artifact prefix are copied in at request time because
-- after the erasure there is no row left to read them from.
CREATE TABLE IF NOT EXISTS "data_request" (
  "id" UUID NOT NULL,
  "org_id" UUID NOT NULL,
  "project_id" UUID,
  "kind" "DataRequestKind" NOT NULL,
  "status" "DataRequestStatus" NOT NULL DEFAULT 'pending',
  "subject" TEXT NOT NULL,
  "actor" TEXT NOT NULL,
  "actor_user_id" UUID,
  "artifact_prefix" TEXT NOT NULL,
  "row_count" INTEGER,
  "artifact_count" INTEGER,
  "residue" JSONB,
  "error" TEXT,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "started_at" TIMESTAMP(3),
  "completed_at" TIMESTAMP(3),

  CONSTRAINT "data_request_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "data_request_status_created_at_idx" ON "data_request" ("status", "created_at");
CREATE INDEX IF NOT EXISTS "data_request_org_id_created_at_idx" ON "data_request" ("org_id", "created_at" DESC);
CREATE INDEX IF NOT EXISTS "data_request_project_id_created_at_idx" ON "data_request" ("project_id", "created_at" DESC);
