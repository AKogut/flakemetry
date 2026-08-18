---
'@flakemetry/contracts': minor
---

The daily LLM token budget is now a per-project policy field. It was read only from the environment, so `ai.dailyTokenBudget` in a project's `flakemetry.yml` was documented, validated and ignored — one instance could have exactly one budget.
