---
'@flakemetry/contracts': patch
'@flakemetry/cli': patch
---

`flakemetry allure` records a test that never ran because a hook failed as skipped instead of failed, so the pass when its spec file is retried is no longer called flaky. Hooks with an empty history id are no longer treated as retries of each other.
