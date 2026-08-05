-- An invitation is a capability to read every run, error message and artifact in the
-- workspace, so it is stored the way ingest tokens are: only the SHA-256 hash, with the raw
-- value shown once at creation. A guessable id in a URL that lives forever in someone's
-- inbox would be the same grant with none of the protection.
CREATE TABLE IF NOT EXISTS "invitation" (
  "id" UUID NOT NULL,
  "org_id" UUID NOT NULL,
  "email" TEXT NOT NULL,
  "role" "MembershipRole" NOT NULL DEFAULT 'member',
  "token_hash" TEXT NOT NULL,
  "invited_by" UUID,
  "expires_at" TIMESTAMP(3) NOT NULL,
  "accepted_at" TIMESTAMP(3),
  "accepted_by" UUID,
  "revoked_at" TIMESTAMP(3),
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "invitation_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "invitation_token_hash_key" ON "invitation" ("token_hash");
CREATE INDEX IF NOT EXISTS "invitation_org_id_created_at_idx" ON "invitation" ("org_id", "created_at" DESC);

DO $$ BEGIN
  ALTER TABLE "invitation" ADD CONSTRAINT "invitation_org_id_fkey"
    FOREIGN KEY ("org_id") REFERENCES "org"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
