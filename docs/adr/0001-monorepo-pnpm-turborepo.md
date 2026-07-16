# ADR-0001: Monorepo with pnpm workspaces and Turborepo

- **Status**: accepted
- **Date**: 2026-07-15

## Context

Flakemetry spans an ingestion contract shared by at least four consumers: the Playwright reporter emits payloads, the api validates them, the worker persists them, and the web dashboard renders what came out the other end. A single schema change must land atomically across all of them, or the contract drifts. At the same time, several packages (`contracts`, `core`, `sdk`, `playwright-reporter`, `ai`, `cli`) must be published to npm independently.

## Decision

One repository, pnpm workspaces for package linking, Turborepo for the task graph, changesets for independent versioned publishing.

`packages/contracts` holds zod schemas as the single source of truth; every other workspace imports from it. Breaking the contract fails typecheck in every consumer in the same commit — the drift class of bugs is eliminated structurally, not by convention.

## Alternatives considered

- **Polyrepo (reporter / platform / dashboard)** — independent release cadence, but the shared contract becomes an npm dependency with version skew: a reporter built against contracts v3 talking to an api validating v5 is exactly the failure mode this project exists to prevent. Cross-cutting changes need coordinated multi-repo PRs.
- **Monorepo without a task runner** — plain `pnpm -r run build` rebuilds everything always; no affected-only CI, no caching. Rejected as CI cost grows linearly with package count.
- **Nx** — heavier featureset than needed; Turborepo covers the required graph + cache with a single json file.

## Consequences

- Atomic cross-layer changes; one PR moves the contract and all consumers.
- CI runs only affected tasks (`turbo --affected`), verified at ~35s for a doc-only PR.
- npm publishing from a monorepo needs explicit machinery — solved by changesets (ADR scope: see release workflow).
- All contributors share one toolchain version pin (`packageManager`), removing works-on-my-machine drift.
