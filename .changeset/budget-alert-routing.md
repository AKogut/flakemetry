---
'@flakemetry/contracts': patch
---

`ai_budget_spent` is now a valid event in a `flakemetry.yml` notification channel. Before this, listing it failed validation, and that one invalid entry stopped every channel in the file from syncing.
