---
'@flakemetry/contracts': minor
---

Two policy fields cap what a project stores: `storageMaxExecutions` (raw executions) and `storageMaxArtifactMb` (artifact storage), with `FLAKEMETRY_STORAGE_MAX_EXECUTIONS` and `FLAKEMETRY_STORAGE_MAX_ARTIFACT_MB` as the environment tier. `0` means no cap.
