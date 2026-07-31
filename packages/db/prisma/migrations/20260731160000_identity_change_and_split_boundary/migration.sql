-- AlterTable
ALTER TABLE "identity_stitch" ADD COLUMN "run_started_at" TIMESTAMP(3);

-- CreateTable
CREATE TABLE "identity_change" (
    "id" UUID NOT NULL,
    "org_id" UUID NOT NULL,
    "project_id" UUID NOT NULL,
    "user_id" UUID,
    "action" TEXT NOT NULL,
    "source_identity_id" UUID NOT NULL,
    "target_identity_id" UUID,
    "fingerprint" TEXT NOT NULL,
    "detail" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "identity_change_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "identity_change_project_id_created_at_idx" ON "identity_change"("project_id", "created_at" DESC);

-- CreateIndex
CREATE INDEX "identity_change_org_id_idx" ON "identity_change"("org_id");

-- AddForeignKey
ALTER TABLE "identity_change" ADD CONSTRAINT "identity_change_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "identity_change" ADD CONSTRAINT "identity_change_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "user"("id") ON DELETE SET NULL ON UPDATE CASCADE;
