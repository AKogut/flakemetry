-- A badge is fetched by GitHub's image proxy with no headers, so whatever authorises it has
-- to sit in the URL. That rules out reusing an ingest token: those grant write, and this one
-- ends up printed in a public README on purpose.
--
-- Stored in the clear rather than hashed, unlike ingest tokens, because the settings page has
-- to show the URL every time it is opened — and unlike an ingest token there is nothing to
-- protect beyond four aggregate numbers. It is a capability that can be rotated, not a secret.
ALTER TABLE "project" ADD COLUMN IF NOT EXISTS "badge_token" TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS "project_badge_token_key" ON "project"("badge_token");
