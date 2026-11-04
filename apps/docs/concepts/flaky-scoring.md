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
- **pass-on-rerun** — failed, then passed on a retry inside the same run. A failure one night and
  a pass the next is not a rerun, so reports with no retry data, such as JUnit, never show this.
- **intermittent across branches** — fails on some branches and not others for no code
  reason.

Because the reasons travel with the score, you can trust it or challenge it — you are never
handed a black-box number.

## When most of a suite fails at once

If an emulator dies or a target goes down, every test fails together. That is an incident, not
evidence about each test, and scoring it would push the whole suite up the board next to the real
flakes.

So failures from a run where **at least 5 tests failed and they were at least half of the tests
it executed** are not counted towards anyone's score. The run still shows its failures, and each
affected test carries a `MASS_FAILURES_SET_ASIDE` reason saying how many were left out. A test
that also fails on its own keeps that evidence.

## Scoring policy

The score at which a test becomes a quarantine candidate, and the minimum number of samples
before a score is surfaced, are configurable per project (and instance-wide). See the
[Configuration reference](/reference/configuration) for the knobs, and
[auto-quarantine](/guide/github-action) for how a high score can automatically stop a test
from failing the build.

The default bar of 0.8 is high on purpose. Crossing it can hide a test's failures, so a test has
to flake in about every second run to reach it. The score ranks tests rather than naming the
ones flaking today: one retry can hold a test above 0.5 for months, and the same one retry can
score 0.34 or 0.59 depending on how many of the test's commits ran twice. The **Test health** page
counts the tests that actually failed and then passed on a retry.

A score is computed as of the test's newest execution, and health events and trends carry that
date. Replaying or importing old results in order gives the history they would have had at the
time. A run that arrives late changes the score from then on and does not rewrite earlier days.

You can overrule it. Quarantining or releasing a test by hand — from the test page, or with
[`flakemetry quarantine`](/guide/cli) — takes that test out of the scorer's hands until you
give it back. A decision the next run silently reverses would be worse than no control at
all, so the automation steps aside rather than arguing.

The full model is documented in the
[Flaky Scoring wiki page](https://github.com/AKogut/flakemetry/wiki/Flaky-Scoring).
