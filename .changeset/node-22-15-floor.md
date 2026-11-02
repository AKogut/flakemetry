---
'@flakemetry/cli': minor
'@flakemetry/contracts': minor
'@flakemetry/core': minor
'@flakemetry/jest-reporter': minor
'@flakemetry/playwright-reporter': minor
'@flakemetry/sdk': minor
'@flakemetry/vitest-reporter': minor
---

Node 22.15 or later is now required, and each package declares it in `engines`. `@flakemetry/sdk` moves to OpenTelemetry 3, which needs that Node and `@opentelemetry/api` 1.10; the reporters are tested on Node 22.15 exactly.
