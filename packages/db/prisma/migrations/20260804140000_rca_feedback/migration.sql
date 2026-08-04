CREATE TYPE "RcaVerdict" AS ENUM ('helpful', 'unhelpful');

ALTER TABLE "rca_report" ADD COLUMN "prompt_version" TEXT NOT NULL DEFAULT 'v1';

CREATE TABLE "rca_feedback" (
    "id" UUID NOT NULL,
    "org_id" UUID NOT NULL,
    "project_id" UUID NOT NULL,
    "report_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "verdict" "RcaVerdict" NOT NULL,
    "correction" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "rca_feedback_pkey" PRIMARY KEY ("id")
);

-- One verdict per person per report: a second opinion replaces the first rather than
-- stacking, so the eval set cannot be skewed by one reviewer clicking repeatedly.
CREATE UNIQUE INDEX "rca_feedback_report_id_user_id_key" ON "rca_feedback"("report_id", "user_id");
CREATE INDEX "rca_feedback_org_id_idx" ON "rca_feedback"("org_id");
CREATE INDEX "rca_feedback_project_id_created_at_idx" ON "rca_feedback"("project_id", "created_at" DESC);

ALTER TABLE "rca_feedback" ADD CONSTRAINT "rca_feedback_project_id_fkey"
    FOREIGN KEY ("project_id") REFERENCES "project"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "rca_feedback" ADD CONSTRAINT "rca_feedback_report_id_fkey"
    FOREIGN KEY ("report_id") REFERENCES "rca_report"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "rca_feedback" ADD CONSTRAINT "rca_feedback_user_id_fkey"
    FOREIGN KEY ("user_id") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;
