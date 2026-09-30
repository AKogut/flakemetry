---
'@flakemetry/core': patch
'@flakemetry/sdk': patch
---

File paths are normalized by segment, so equivalent spellings of a path give one fingerprint. `/./tests/a.spec.ts`, `././tests/a.spec.ts`, `tests//a.spec.ts` and `tests/./a.spec.ts` used to give different fingerprints, which could split one test's history across identities when it was reported through more than one route. Paths without such segments normalize exactly as before, so existing fingerprints do not change.
