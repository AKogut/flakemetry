-- AlterTable
ALTER TABLE "test_identity" ADD COLUMN "params" JSONB;

-- CreateIndex
CREATE INDEX "test_identity_project_id_suite_title_params_hash_idx" ON "test_identity"("project_id", "suite", "title", "params_hash");
