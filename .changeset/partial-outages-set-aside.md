---
'@flakemetry/core': minor
---

A partial outage no longer counts as evidence that each test is flaky. A failure is left out of the score when at least 5 tests, and at least a tenth of the run, failed with the same error, the test did not pass on a retry in that run, and the same test passed on that commit in another run. The test carries a `SHARED_FAILURES_SET_ASIDE` reason saying how many. A bug that fails on every run of its commit keeps counting. The model version moves to `0.5.0`, and existing scores change the next time a test runs.
