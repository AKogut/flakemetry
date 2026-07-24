-- AlterTable
ALTER TABLE "ingestion_job" ALTER COLUMN "visible_at" SET DEFAULT now();

-- CreateTable
CREATE TABLE "project_policy" (
    "project_id" UUID NOT NULL,
    "org_id" UUID NOT NULL,
    "flaky_threshold" DOUBLE PRECISION,
    "min_samples" INTEGER,
    "quarantine_enabled" BOOLEAN,
    "quarantine_cooldown_runs" INTEGER,
    "ai_rca_enabled" BOOLEAN,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "project_policy_pkey" PRIMARY KEY ("project_id")
);

-- CreateTable
CREATE TABLE "policy_change" (
    "id" UUID NOT NULL,
    "org_id" UUID NOT NULL,
    "project_id" UUID NOT NULL,
    "user_id" UUID,
    "field" TEXT NOT NULL,
    "old_value" TEXT,
    "new_value" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "policy_change_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "project_policy_org_id_idx" ON "project_policy"("org_id");

-- CreateIndex
CREATE INDEX "policy_change_project_id_created_at_idx" ON "policy_change"("project_id", "created_at" DESC);

-- CreateIndex
CREATE INDEX "policy_change_org_id_idx" ON "policy_change"("org_id");

-- AddForeignKey
ALTER TABLE "project_policy" ADD CONSTRAINT "project_policy_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "policy_change" ADD CONSTRAINT "policy_change_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "policy_change" ADD CONSTRAINT "policy_change_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "user"("id") ON DELETE SET NULL ON UPDATE CASCADE;
