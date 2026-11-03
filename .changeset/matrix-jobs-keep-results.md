---
'@flakemetry/contracts': patch
'@flakemetry/sdk': patch
'@flakemetry/cli': patch
---

Jobs of a CI matrix no longer lose their results. Reporters add a digest of the results to the idempotency key, so jobs that share a CI run id get their own key and their artifacts no longer overwrite each other. `flakemetry upload`, `flakemetry junit` and `flakemetry import` now say when the server already had a run, instead of reporting it as uploaded.
