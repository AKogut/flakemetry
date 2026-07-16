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
