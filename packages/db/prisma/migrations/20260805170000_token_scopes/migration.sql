-- Until now a token was a token: whatever could push results could do everything the API
-- offered. A public read API needs credentials that can be handed to a dashboard, a script
-- or a colleague without also granting the ability to forge test data.
--
-- Existing tokens get exactly what they already had. Widening them here to include read
-- would hand every CI token in every project a capability nobody asked for.
ALTER TABLE "ingest_token"
  ADD COLUMN IF NOT EXISTS "scopes" TEXT[] NOT NULL DEFAULT ARRAY['ingest'];

UPDATE "ingest_token" SET "scopes" = ARRAY['ingest'] WHERE cardinality("scopes") = 0;
