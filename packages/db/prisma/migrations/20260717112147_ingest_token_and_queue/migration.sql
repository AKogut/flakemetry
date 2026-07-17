-- CreateEnum
CREATE TYPE "IngestionJobStatus" AS ENUM ('pending', 'processing', 'done', 'dead');

-- CreateTable
CREATE TABLE "ingest_token" (
    "id" UUID NOT NULL,
    "org_id" UUID NOT NULL,
    "project_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "token_hash" TEXT NOT NULL,
    "last_used_at" TIMESTAMP(3),
    "revoked_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ingest_token_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ingestion_job" (
    "id" UUID NOT NULL,
    "org_id" UUID NOT NULL,
    "project_id" UUID NOT NULL,
    "idempotency_key" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "status" "IngestionJobStatus" NOT NULL DEFAULT 'pending',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "visible_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_error" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ingestion_job_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ingest_token_token_hash_key" ON "ingest_token"("token_hash");

-- CreateIndex
CREATE INDEX "ingest_token_org_id_idx" ON "ingest_token"("org_id");

-- CreateIndex
CREATE INDEX "ingest_token_project_id_idx" ON "ingest_token"("project_id");

-- CreateIndex
CREATE INDEX "ingestion_job_status_visible_at_idx" ON "ingestion_job"("status", "visible_at");

-- CreateIndex
CREATE INDEX "ingestion_job_org_id_idx" ON "ingestion_job"("org_id");

-- CreateIndex
CREATE UNIQUE INDEX "ingestion_job_project_id_idempotency_key_key" ON "ingestion_job"("project_id", "idempotency_key");

-- AddForeignKey
ALTER TABLE "ingest_token" ADD CONSTRAINT "ingest_token_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ingestion_job" ADD CONSTRAINT "ingestion_job_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "project"("id") ON DELETE CASCADE ON UPDATE CASCADE;
