---
'@flakemetry/contracts': minor
'@flakemetry/sdk': minor
'@flakemetry/cli': minor
---

A run that fails before any test executes is no longer invisible. `flakemetry run` reports a failed run with no tests when the command fails without writing results, and still exits with the command's code. A run now also records its variant from `FLAKEMETRY_VARIANT`.
