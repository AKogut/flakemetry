-- AlterTable
ALTER TABLE "test_execution" ADD COLUMN "merged_from_identity_id" UUID;

-- AlterTable
ALTER TABLE "test_health_event" ADD COLUMN "merged_from_identity_id" UUID;

-- AlterTable
ALTER TABLE "identity_stitch" ADD COLUMN "merged_from_identity_id" UUID;

-- CreateIndex
CREATE INDEX "test_execution_merged_from_identity_id_idx" ON "test_execution"("merged_from_identity_id");

-- CreateTable
CREATE TABLE "identity_merge" (
    "id" UUID NOT NULL,
    "org_id" UUID NOT NULL,
    "project_id" UUID NOT NULL,
    "target_identity_id" UUID NOT NULL,
    "source_identity_id" UUID NOT NULL,
    "source_fingerprint" TEXT NOT NULL,
    "source_file_path" TEXT NOT NULL,
    "source_suite" TEXT NOT NULL,
    "source_title" TEXT NOT NULL,
    "source_params_hash" TEXT,
    "source_params" JSONB,
    "source_aliases" TEXT[],
    "source_first_seen_at" TIMESTAMP(3) NOT NULL,
    "source_last_seen_at" TIMESTAMP(3) NOT NULL,
    "undone_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "identity_merge_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "identity_merge_target_identity_id_created_at_idx" ON "identity_merge"("target_identity_id", "created_at" DESC);

-- CreateIndex
CREATE INDEX "identity_merge_org_id_idx" ON "identity_merge"("org_id");

-- AddForeignKey
ALTER TABLE "identity_merge" ADD CONSTRAINT "identity_merge_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "project"("id") ON DELETE CASCADE ON UPDATE CASCADE;
