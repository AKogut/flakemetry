# Flaky scoring

Most teams "detect" flakes by eyeballing `retries > 0`. That is noisy in both directions —
it flags a test that failed once for a real reason, and misses a test that fails one run in
twenty. Flakemetry replaces the eyeball with a transparent statistical model that ships its
reasoning alongside every score.

## The model

The flaky score is a **Beta-Binomial** estimate of a test's failure-inconsistency rate,
with **exponential time-decay** so recent behaviour counts for more than last month's. A
Bayesian prior means a test does not swing to "extremely flaky" on a single red run; it
needs enough samples before the score becomes confident. That is why a brand-new test with
one failure does not top the board.

## The strongest signal: same commit, different result

The single most powerful evidence of flakiness is **same commit, different result** — the
code did not change but the outcome did. A deterministic failure repeats on the same
commit; a flaky one does not. The model weighs this signal heavily because it isolates
non-determinism from genuine regressions.

## Reason codes

Every score is explainable. It ships with **reason codes** — the human-readable evidence
behind the number:

- **same commit, different result** — flip-flopped outcomes with no code change.
- **pass-on-rerun** — failed, then passed on retry with no code change.
- **intermittent across branches** — fails on some branches and not others for no code
  reason.

Because the reasons travel with the score, you can trust it or challenge it — you are never
handed a black-box number.

## Scoring policy

The threshold at which a test is considered flaky, and the minimum number of samples before
a score is surfaced, are configurable per project (and instance-wide). See the
[Configuration reference](/reference/configuration) for the knobs, and
[auto-quarantine](/guide/github-action) for how a high score can automatically stop a test
from failing the build.

The full model is documented in the
[Flaky Scoring wiki page](https://github.com/AKogut/flakemetry/wiki/Flaky-Scoring).
