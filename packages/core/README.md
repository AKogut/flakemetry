# @flakemetry/core

Pure domain logic for [Flakemetry](https://github.com/AKogut/flakemetry): the test identity engine and the explainable flaky-scoring model. No I/O, no database — just functions you can reason about and test.

## Install

```bash
pnpm add @flakemetry/core
```

## Test identity

A test keeps its history when the file it lives in moves. `computeFingerprint` is the exact (L1) match; `resolveIdentity` falls back to a suite+title+params match (L2) and records an alias so history stitches together.

```ts
import { computeFingerprint, resolveIdentity } from '@flakemetry/core'

const fingerprint = computeFingerprint({
  filePath: 'e2e/auth/login.spec.ts',
  suite: 'auth',
  title: 'logs in',
  paramsHash: null,
})

resolveIdentity({ fingerprint, suite: 'auth', title: 'logs in', paramsHash: null }, existing)
// → { kind: 'moved', identityId, level: 'L2', addAlias } when only the path changed
```

## Flaky scoring

A transparent Beta-Binomial model with exponential time decay. Every score carries human-readable reason codes, and the model version is stamped for reproducibility.

```ts
import { computeFlakyScore } from '@flakemetry/core'

const result = computeFlakyScore(history, { now: new Date() })
// result.score, result.reasonCodes, result.quarantineCandidate, result.modelVersion
```

Signals, weighted into the score:

| Signal | Weight | Meaning |
|---|---|---|
| `sameShaVariance` | 0.40 | different results on one commit — the strongest evidence of flakiness |
| `instability` | 0.20 | Beta-Binomial posterior with 14-day half-life |
| `flipRate` | 0.15 | pass/fail transitions between runs |
| `entropy` | 0.10 | Shannon entropy of outcomes |
| `passOnRerunRate` | 0.10 | recovered on retry within the same commit |
| `failIsolation` | 0.05 | failed alone (test-specific) vs alongside a broken run (environmental) |

Scoring is deterministic for the same history and runs over a bounded recent window, so cost stays constant as history grows.

## License

MIT © Andrii Kohut
