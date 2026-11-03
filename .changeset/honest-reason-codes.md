---
'@flakemetry/core': patch
---

Reason codes now describe what happened. `PASS_ON_RERUN` needs a retry inside one run, a test that has only ever been skipped scores 0 with `NEVER_EXECUTED`, and `RECENT_INSTABILITY` needs at least one failure. A row with status `flaky`, which is how Vitest, Jest and pytest report a passing retry, now counts as evidence instead of being ignored.
