DO $$ BEGIN
  CREATE TYPE "QuarantineOverride" AS ENUM ('quarantined', 'released');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- Null means the scorer decides, which is what every existing row means: nothing was ever
-- decided by hand, because until now nothing could be. Set, it means a person decided and
-- the scorer must not move this test in either direction — releasing a still-flaky test is
-- as much a decision as quarantining a healthy one, and the automation would otherwise
-- revert both on the next run.
ALTER TABLE "test_identity" ADD COLUMN IF NOT EXISTS "quarantine_override" "QuarantineOverride";
ALTER TABLE "test_identity" ADD COLUMN IF NOT EXISTS "quarantine_override_by" UUID;
ALTER TABLE "test_identity" ADD COLUMN IF NOT EXISTS "quarantine_override_at" TIMESTAMP(3);
