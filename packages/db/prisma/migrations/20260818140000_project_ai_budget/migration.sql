-- The daily token cap was read only from the environment, so `ai.dailyTokenBudget` in a
-- project's flakemetry.yml was documented, validated and ignored — one instance could have
-- exactly one budget. This gives it the same per-project tier every other policy field has.
ALTER TABLE "project_policy" ADD COLUMN IF NOT EXISTS "ai_daily_token_budget" INTEGER;
