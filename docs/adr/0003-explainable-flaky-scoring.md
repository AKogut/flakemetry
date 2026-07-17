# ADR-0003: Explainable statistical flaky scoring over black-box ML

- **Status**: accepted
- **Date**: 2026-07-15

## Context

Flaky detection is the product's central promise. The output drives real actions — quarantining a test, blocking or unblocking a merge — so an SDET must be able to challenge the verdict. Labelled training data for flakiness is scarce, noisy and project-specific; a supervised classifier would ship as an opaque number nobody can argue with.

The strongest flakiness evidence needs no model at all: the same commit producing different results is near-proof.

## Decision

A transparent Beta-Binomial model with exponential time-decay, fed by named signals (`flip_rate`, `pass_on_rerun_rate`, `same_sha_variance`, `entropy`, `fail_isolation`). Every score is accompanied by machine-generated, human-readable reason codes ("passed on rerun 4/5 times", "flipped 3 times on commit abc123"). Scores are deterministic given the same history and stamped with a `model_version`.

## Alternatives considered

- **Gradient-boosted classifier** — potentially marginal accuracy gains, but unexplainable output, cold-start dependence on labelled data, and non-reproducible scores across retraining. Trust is the product; a number without a why erodes it.
- **Simple thresholds (fails N times in M runs)** — explainable but blunt: no recency weighting, no distinction between infra outages and per-test flakiness, easily gamed by retries.

## Consequences

- Every score is auditable and reproducible; disputes resolve by reading reason codes, not by faith.
- The model heals: a stabilized test decays its flaky history away without manual resets.
- Ceiling on raw accuracy versus a trained model — accepted; ML-derived *signals* can feed the same transparent aggregation later without changing the surface.
- Requires a stable test identity to attribute history correctly, making the identity engine a hard dependency.

## Implementation status (`model_version` 0.2.0)

Score is a weighted blend of all five signals: `same_sha_variance` 0.40 (strongest — different results on one commit), Bayesian `instability` 0.20 (Beta-Binomial with 14-day exponential decay), `flip_rate` 0.15, `entropy` 0.10, `pass_on_rerun_rate` 0.10, `fail_isolation` 0.05. `fail_isolation` distinguishes a test that fails **alone** (test-specific, more suspicious) from one failing alongside a broken run (environmental) using the count of failing tests per run.

Reason codes are emitted for each triggered signal, with a `STABLE` floor so every score carries at least one explanation. Scoring runs over a bounded recent window (500 executions) so cost is constant per update rather than growing with total history; because re-processing a batch is idempotent, the window is recomputed from current state rather than folded incrementally.
