-- A confirmed flake needs a durable, assignable home. Notifications are ephemeral: they
-- fire once and nothing reflects when the test recovers.
ALTER TABLE "project" ADD COLUMN IF NOT EXISTS "repository" TEXT;

ALTER TABLE "project_policy"
  ADD COLUMN IF NOT EXISTS "tracker_enabled" BOOLEAN,
  ADD COLUMN IF NOT EXISTS "tracker_after_days" INTEGER,
  ADD COLUMN IF NOT EXISTS "tracker_recovery_days" INTEGER;

CREATE TABLE IF NOT EXISTS "tracker_issue" (
  "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "org_id" UUID NOT NULL,
  "project_id" UUID NOT NULL,
  -- One issue per test identity, enforced by the database rather than by the sweep
  -- remembering to check: duplicate tickets for one flake are the failure mode here.
  "test_identity_id" UUID NOT NULL UNIQUE,
  "provider" TEXT NOT NULL DEFAULT 'github',
  "external_id" TEXT NOT NULL,
  "url" TEXT NOT NULL,
  "state" TEXT NOT NULL DEFAULT 'open',
  "last_score" DOUBLE PRECISION,
  "opened_at" TIMESTAMP(3) NOT NULL DEFAULT now(),
  "closed_at" TIMESTAMP(3),
  "last_synced_at" TIMESTAMP(3) NOT NULL DEFAULT now(),
  CONSTRAINT "tracker_issue_project_id_fkey" FOREIGN KEY ("project_id")
    REFERENCES "project"("id") ON DELETE CASCADE,
  CONSTRAINT "tracker_issue_test_identity_id_fkey" FOREIGN KEY ("test_identity_id")
    REFERENCES "test_identity"("id") ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS "tracker_issue_project_id_state_idx" ON "tracker_issue"("project_id", "state");
CREATE INDEX IF NOT EXISTS "tracker_issue_org_id_idx" ON "tracker_issue"("org_id");
