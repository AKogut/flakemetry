---
'@flakemetry/contracts': minor
'@flakemetry/sdk': minor
'@flakemetry/cli': minor
'@flakemetry/playwright-reporter': minor
---

A test's browser, platform or target is now part of its identity. Playwright records the project as the variant when a config has more than one, and `FLAKEMETRY_VARIANT` or `flakemetry import --variant` sets it for any other runner, so a test that always fails on one browser no longer reads as flaky everywhere. A single-project config keeps its identities and history. Parameters now travel over OTLP too, which they did not before, so both transports produce the same identity.
