---
'@flakemetry/notify': minor
---

New `ai_budget_spent` notification, sent when a project's daily LLM token budget runs out and root-cause analysis pauses. Subscribe on any channel — Slack, Discord, email or a signed webhook. Deduplicated per project per day, since the budget is re-checked on every run.
