---
'@flakemetry/sdk': patch
'@flakemetry/jest-reporter': patch
'@flakemetry/vitest-reporter': patch
---

Sharded Jest and Vitest runs keep every shard. Each shard of one CI run used to get the same idempotency key, so the API kept the first shard and dropped the rest as re-deliveries. The reporters now pass the runner's `--shard` to the SDK, and the SDK reads `FLAKEMETRY_SHARD_INDEX` / `FLAKEMETRY_SHARD_TOTAL`, which were documented but never read, for suites split some other way.
