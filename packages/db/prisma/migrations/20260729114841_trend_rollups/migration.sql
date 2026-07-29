-- AlterTable
ALTER TABLE "ingestion_job" ALTER COLUMN "visible_at" SET DEFAULT now();

-- CreateTable
CREATE TABLE "daily_test_stats" (
    "project_id" UUID NOT NULL,
    "org_id" UUID NOT NULL,
    "test_identity_id" UUID NOT NULL,
    "day" DATE NOT NULL,
    "total" INTEGER NOT NULL DEFAULT 0,
    "passed" INTEGER NOT NULL DEFAULT 0,
    "failed" INTEGER NOT NULL DEFAULT 0,
    "flaky" INTEGER NOT NULL DEFAULT 0,
    "skipped" INTEGER NOT NULL DEFAULT 0,
    "avg_duration_ms" INTEGER NOT NULL DEFAULT 0,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "daily_test_stats_pkey" PRIMARY KEY ("test_identity_id","day")
);

-- CreateTable
CREATE TABLE "suite_daily" (
    "project_id" UUID NOT NULL,
    "org_id" UUID NOT NULL,
    "suite" TEXT NOT NULL,
    "day" DATE NOT NULL,
    "total" INTEGER NOT NULL DEFAULT 0,
    "passed" INTEGER NOT NULL DEFAULT 0,
    "failed" INTEGER NOT NULL DEFAULT 0,
    "flaky" INTEGER NOT NULL DEFAULT 0,
    "skipped" INTEGER NOT NULL DEFAULT 0,
    "avg_duration_ms" INTEGER NOT NULL DEFAULT 0,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "suite_daily_pkey" PRIMARY KEY ("project_id","suite","day")
);

-- CreateTable
CREATE TABLE "flaky_trends" (
    "project_id" UUID NOT NULL,
    "org_id" UUID NOT NULL,
    "day" DATE NOT NULL,
    "flaky_count" INTEGER NOT NULL DEFAULT 0,
    "quarantined_count" INTEGER NOT NULL DEFAULT 0,
    "avg_score" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "flaky_trends_pkey" PRIMARY KEY ("project_id","day")
);

-- CreateIndex
CREATE INDEX "daily_test_stats_project_id_day_idx" ON "daily_test_stats"("project_id", "day");

-- CreateIndex
CREATE INDEX "suite_daily_project_id_day_idx" ON "suite_daily"("project_id", "day");

-- AddForeignKey
ALTER TABLE "daily_test_stats" ADD CONSTRAINT "daily_test_stats_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "daily_test_stats" ADD CONSTRAINT "daily_test_stats_test_identity_id_fkey" FOREIGN KEY ("test_identity_id") REFERENCES "test_identity"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "suite_daily" ADD CONSTRAINT "suite_daily_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "flaky_trends" ADD CONSTRAINT "flaky_trends_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "project"("id") ON DELETE CASCADE ON UPDATE CASCADE;
