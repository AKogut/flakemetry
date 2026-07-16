-- CreateEnum
CREATE TYPE "TestStatus" AS ENUM ('pass', 'fail', 'skip', 'flaky');

-- CreateEnum
CREATE TYPE "RunStatus" AS ENUM ('running', 'passed', 'failed', 'canceled');

-- CreateEnum
CREATE TYPE "CiProvider" AS ENUM ('github_actions', 'gitlab_ci', 'circleci', 'jenkins', 'local', 'other');

-- CreateEnum
CREATE TYPE "RunTrigger" AS ENUM ('push', 'pull_request', 'schedule', 'manual', 'other');

-- CreateTable
CREATE TABLE "org" (
    "id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "org_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "project" (
    "id" UUID NOT NULL,
    "org_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "default_branch" TEXT NOT NULL DEFAULT 'main',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "project_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "test_identity" (
    "id" UUID NOT NULL,
    "org_id" UUID NOT NULL,
    "project_id" UUID NOT NULL,
    "fingerprint" TEXT NOT NULL,
    "file_path" TEXT NOT NULL,
    "suite" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "params_hash" TEXT,
    "aliases" TEXT[],
    "quarantined" BOOLEAN NOT NULL DEFAULT false,
    "quarantine_reason" TEXT,
    "first_seen_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_seen_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "test_identity_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "run" (
    "id" UUID NOT NULL,
    "org_id" UUID NOT NULL,
    "project_id" UUID NOT NULL,
    "idempotency_key" TEXT NOT NULL,
    "commit_sha" TEXT NOT NULL,
    "branch" TEXT NOT NULL,
    "pr_number" INTEGER,
    "ci_provider" "CiProvider" NOT NULL,
    "ci_run_id" TEXT,
    "trigger" "RunTrigger" NOT NULL,
    "status" "RunStatus" NOT NULL,
    "started_at" TIMESTAMP(3) NOT NULL,
    "finished_at" TIMESTAMP(3),
    "duration_ms" INTEGER,
    "git_diff_stat" JSONB,
    "otel_trace_id" TEXT,

    CONSTRAINT "run_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "test_execution" (
    "id" UUID NOT NULL,
    "org_id" UUID NOT NULL,
    "project_id" UUID NOT NULL,
    "run_id" UUID NOT NULL,
    "test_identity_id" UUID NOT NULL,
    "attempt" INTEGER NOT NULL DEFAULT 1,
    "retry_of" UUID,
    "status" "TestStatus" NOT NULL,
    "duration_ms" INTEGER NOT NULL,
    "error_message" TEXT,
    "error_signature_id" UUID,
    "otel_trace_id" TEXT,
    "otel_span_id" TEXT,
    "artifacts_ref" JSONB,
    "attributes" JSONB,
    "started_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "test_execution_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "flaky_score" (
    "test_identity_id" UUID NOT NULL,
    "org_id" UUID NOT NULL,
    "project_id" UUID NOT NULL,
    "score" DOUBLE PRECISION NOT NULL,
    "flip_rate" DOUBLE PRECISION NOT NULL,
    "pass_on_rerun_rate" DOUBLE PRECISION NOT NULL,
    "same_sha_variance" DOUBLE PRECISION NOT NULL,
    "entropy" DOUBLE PRECISION NOT NULL,
    "fail_isolation" DOUBLE PRECISION NOT NULL,
    "reason_codes" JSONB NOT NULL,
    "quarantine_candidate" BOOLEAN NOT NULL DEFAULT false,
    "last_flaked_at" TIMESTAMP(3),
    "model_version" TEXT NOT NULL,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "flaky_score_pkey" PRIMARY KEY ("test_identity_id")
);

-- CreateTable
CREATE TABLE "error_signature" (
    "id" UUID NOT NULL,
    "org_id" UUID NOT NULL,
    "project_id" UUID NOT NULL,
    "normalized_hash" TEXT NOT NULL,
    "sample_message" TEXT NOT NULL,
    "stack_template" TEXT NOT NULL,
    "cluster_id" UUID,
    "occurrence_count" INTEGER NOT NULL DEFAULT 1,
    "known_issue_ref" TEXT,
    "first_seen_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_seen_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "error_signature_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "rca_report" (
    "id" UUID NOT NULL,
    "org_id" UUID NOT NULL,
    "project_id" UUID NOT NULL,
    "execution_id" UUID NOT NULL,
    "signature_id" UUID NOT NULL,
    "summary" TEXT NOT NULL,
    "likely_cause" TEXT NOT NULL,
    "suggested_action" TEXT NOT NULL,
    "confidence" DOUBLE PRECISION NOT NULL,
    "similar_past" JSONB NOT NULL,
    "llm_model" TEXT NOT NULL,
    "token_cost" INTEGER NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "rca_report_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "org_slug_key" ON "org"("slug");

-- CreateIndex
CREATE INDEX "project_org_id_idx" ON "project"("org_id");

-- CreateIndex
CREATE UNIQUE INDEX "project_org_id_slug_key" ON "project"("org_id", "slug");

-- CreateIndex
CREATE INDEX "test_identity_org_id_idx" ON "test_identity"("org_id");

-- CreateIndex
CREATE INDEX "test_identity_project_id_last_seen_at_idx" ON "test_identity"("project_id", "last_seen_at" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "test_identity_project_id_fingerprint_key" ON "test_identity"("project_id", "fingerprint");

-- CreateIndex
CREATE INDEX "run_org_id_idx" ON "run"("org_id");

-- CreateIndex
CREATE INDEX "run_project_id_started_at_idx" ON "run"("project_id", "started_at" DESC);

-- CreateIndex
CREATE INDEX "run_project_id_branch_started_at_idx" ON "run"("project_id", "branch", "started_at" DESC);

-- CreateIndex
CREATE INDEX "run_project_id_commit_sha_idx" ON "run"("project_id", "commit_sha");

-- CreateIndex
CREATE UNIQUE INDEX "run_project_id_idempotency_key_key" ON "run"("project_id", "idempotency_key");

-- CreateIndex
CREATE INDEX "test_execution_org_id_idx" ON "test_execution"("org_id");

-- CreateIndex
CREATE INDEX "test_execution_run_id_idx" ON "test_execution"("run_id");

-- CreateIndex
CREATE INDEX "test_execution_test_identity_id_started_at_idx" ON "test_execution"("test_identity_id", "started_at" DESC);

-- CreateIndex
CREATE INDEX "test_execution_project_id_started_at_idx" ON "test_execution"("project_id", "started_at" DESC);

-- CreateIndex
CREATE INDEX "test_execution_error_signature_id_idx" ON "test_execution"("error_signature_id");

-- CreateIndex
CREATE INDEX "flaky_score_org_id_idx" ON "flaky_score"("org_id");

-- CreateIndex
CREATE INDEX "flaky_score_project_id_score_idx" ON "flaky_score"("project_id", "score" DESC);

-- CreateIndex
CREATE INDEX "error_signature_org_id_idx" ON "error_signature"("org_id");

-- CreateIndex
CREATE UNIQUE INDEX "error_signature_project_id_normalized_hash_key" ON "error_signature"("project_id", "normalized_hash");

-- CreateIndex
CREATE UNIQUE INDEX "rca_report_execution_id_key" ON "rca_report"("execution_id");

-- CreateIndex
CREATE INDEX "rca_report_org_id_idx" ON "rca_report"("org_id");

-- CreateIndex
CREATE INDEX "rca_report_project_id_created_at_idx" ON "rca_report"("project_id", "created_at" DESC);

-- CreateIndex
CREATE INDEX "rca_report_signature_id_idx" ON "rca_report"("signature_id");

-- AddForeignKey
ALTER TABLE "project" ADD CONSTRAINT "project_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "org"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "test_identity" ADD CONSTRAINT "test_identity_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "run" ADD CONSTRAINT "run_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "test_execution" ADD CONSTRAINT "test_execution_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "test_execution" ADD CONSTRAINT "test_execution_run_id_fkey" FOREIGN KEY ("run_id") REFERENCES "run"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "test_execution" ADD CONSTRAINT "test_execution_test_identity_id_fkey" FOREIGN KEY ("test_identity_id") REFERENCES "test_identity"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "test_execution" ADD CONSTRAINT "test_execution_error_signature_id_fkey" FOREIGN KEY ("error_signature_id") REFERENCES "error_signature"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "flaky_score" ADD CONSTRAINT "flaky_score_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "flaky_score" ADD CONSTRAINT "flaky_score_test_identity_id_fkey" FOREIGN KEY ("test_identity_id") REFERENCES "test_identity"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "error_signature" ADD CONSTRAINT "error_signature_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "rca_report" ADD CONSTRAINT "rca_report_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "rca_report" ADD CONSTRAINT "rca_report_execution_id_fkey" FOREIGN KEY ("execution_id") REFERENCES "test_execution"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "rca_report" ADD CONSTRAINT "rca_report_signature_id_fkey" FOREIGN KEY ("signature_id") REFERENCES "error_signature"("id") ON DELETE CASCADE ON UPDATE CASCADE;
