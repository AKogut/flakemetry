---
'@flakemetry/core': patch
'@flakemetry/contracts': minor
---

Test health no longer calls a project free of flakes because nothing reached the quarantine bar. `health.metrics` adds `passedOnRetry`, the tests that failed and then passed on a retry, per week and in total, and `highestScore`. Scores, health events and trend rows are now dated from a test's newest execution rather than the time of processing, so replaying or importing old results gives real history. The model version moves to `0.4.0`, and existing scores change the next time a test runs.
