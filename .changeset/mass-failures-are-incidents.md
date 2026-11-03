---
'@flakemetry/core': minor
---

A run where most of the suite failed no longer counts as evidence that each test is flaky. Failures from a run with at least 5 failing tests that are at least half of what it executed are left out of the score, and the test carries a `MASS_FAILURES_SET_ASIDE` reason saying how many.
