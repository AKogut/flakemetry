<div align="center">

# Flakemetry

### OpenTelemetry-native test intelligence platform

**Treat every test run as a trace, not a report.**

Test observability · explainable flaky-test detection · AI-assisted root-cause analysis

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](./LICENSE)
[![TypeScript](https://img.shields.io/badge/TypeScript-strict-3178c6.svg)](https://www.typescriptlang.org/)
[![OpenTelemetry](https://img.shields.io/badge/OpenTelemetry-native-f5a800.svg)](https://opentelemetry.io/)
[![PRs welcome](https://img.shields.io/badge/PRs-welcome-brightgreen.svg)](https://github.com/AKogut/flakemetry/issues)
[![Roadmap](https://img.shields.io/badge/roadmap-public-5319e7.svg)](https://github.com/users/AKogut/projects/14)

[Wiki](https://github.com/AKogut/flakemetry/wiki) · [Architecture](https://github.com/AKogut/flakemetry/wiki/Architecture) · [Roadmap](https://github.com/AKogut/flakemetry/wiki/Roadmap) · [Discussions](https://github.com/AKogut/flakemetry/discussions)

</div>

> **Status: early development, built in the open.** Foundations are landing milestone by milestone (M0 → M6). Follow the [public roadmap board](https://github.com/users/AKogut/projects/14).

---

## Why Flakemetry

Test tooling is stuck. Three systemic gaps:

- **Tests are report artifacts, not telemetry.** JUnit XML and HTML reports capture *one* run — no history, no trace context, no correlation with application signals.
- **Flaky detection is primitive.** Most teams "detect" flakes by eyeballing `retries > 0`. No stable identity across refactors, no statistical model, no auto-quarantine.
- **Root-cause is manual archaeology.** Every failure means digging through logs, stack traces, screenshots, and git blame — 20–40 minutes an incident.

Test reporters answer *"what happened in this run?"* **Flakemetry answers *"is this test trustworthy, why is it failing, and is it getting worse?"*** — across every run, branch, and refactor.

## The idea: tests as traces

If every test execution is modelled as an **OpenTelemetry span**, then historical analytics, flaky scoring, and AI root-cause become natural extensions of the telemetry instead of bolted-on hacks. That single decision is the platform's technical moat.

## What it does

| Capability | What you get |
|---|---|
| **Test observability** | Every run ingested as OTLP; full history per test, not per report |
| **Stable test identity** | Fingerprints that survive file moves, renames, and parameterization |
| **Explainable flaky scoring** | A transparent Bayesian score with human-readable reason codes — not a black box |
| **AI root-cause analysis** | Structured "likely cause + suggested action", budget-gated, provider-agnostic (Claude or local Ollama) |
| **CI-native** | GitHub Action + sticky PR comment; never blocks your build |
| **Self-hostable** | One `docker compose up`, MIT-licensed core |

## Architecture

```
 reporter / OTLP / GitHub Action
              │  OTLP-HTTP, zstd, idempotency-key
              ▼
   Ingestion API (Fastify) ── validate + enqueue ─▶ 202 (never blocks CI)
              │
              ▼   durable queue (Postgres SKIP LOCKED)
   Workers ── normalize ▶ test identity ▶ flaky scoring ▶ signature clustering ▶ AI RCA
              │
              ▼
   PostgreSQL (relational + JSONB + pgvector) · Object store (S3/MinIO)
              │
              ▼
   Query API (tRPC/REST) ─▶ Next.js dashboard  (runs · test history · flaky board · RCA)
```

The write path returns `202` instantly and does the heavy work asynchronously — **ingestion never blocks CI**. Full design in the [Architecture wiki](https://github.com/AKogut/flakemetry/wiki/Architecture).

## Quickstart

```bash
git clone https://github.com/AKogut/flakemetry.git
cd flakemetry
pnpm install
docker compose up
```

Add the reporter to a Playwright project:

```ts
import { defineConfig } from '@playwright/test'

export default defineConfig({
  reporter: [['@flakemetry/playwright-reporter']],
})
```

Wire it into CI:

```yaml
- uses: AKogut/flakemetry/.github/actions/flakemetry@main
  if: always()
  with:
    token: ${{ secrets.FLAKEMETRY_TOKEN }}
```

## How it works

- **[Test Identity Engine](https://github.com/AKogut/flakemetry/wiki/Test-Identity-Engine)** — a multi-level fingerprint (exact → moved → renamed → parameterized) that stitches history across refactors, so a flaky test doesn't reset to zero when a file moves.
- **[Flaky Scoring](https://github.com/AKogut/flakemetry/wiki/Flaky-Scoring)** — a Beta-Binomial model with exponential time-decay. The strongest signal is *same commit, different result*. Every score ships with reason codes explaining it.
- **[AI RCA](https://github.com/AKogut/flakemetry/wiki/AI-RCA-Architecture)** — failures are normalized and clustered cheaply; only genuinely new signatures reach an LLM, budget-gated and cached per cluster.
- **[OTel Test Conventions](https://github.com/AKogut/flakemetry/wiki/OTel-Test-Conventions)** — the span and attribute model every reporter emits to.

## Monorepo layout

```
apps/
  web/            Next.js dashboard
  api/            Fastify ingestion + tRPC query
  worker/         processing (identity, scoring, clustering, RCA)
packages/
  contracts/      zod schemas + shared types (single source of truth)
  db/             Prisma schema + migrations
  core/           pure domain logic (identity, flaky scoring)
  reporter/       @flakemetry/playwright-reporter
  sdk/            OTel instrumentation + ingest client
  ai/             LLMProvider abstraction + RCA
  cli/            @flakemetry/cli
```

Built with pnpm workspaces + Turborepo. Rationale in [ADR-0001](https://github.com/AKogut/flakemetry/wiki/Architecture).

## Roadmap

| Milestone | Focus |
|---|---|
| **M0** | Foundation & DevEx — monorepo, contracts, schema, CI, one-command local dev |
| **M1** | MVP — OTel-native ingestion, test identity, explainable flaky scoring, AI RCA, dashboard, GitHub Action |
| **M2** | Deep observability — full traces, artifacts, waterfall, suite health |
| **M3** | Test intelligence — clustering, known-issue detection, auto-quarantine |
| **M4** | Platform — multi-framework reporters, plugins, public API |
| **M5** | SaaS & scale — multi-tenant, RBAC/SSO, columnar span store |
| **M6** | Community, docs & launch |

Tracked issue-by-issue on the [roadmap board](https://github.com/users/AKogut/projects/14).

## Documentation

Full documentation lives in the [**Wiki**](https://github.com/AKogut/flakemetry/wiki): product vision, architecture, data model, algorithms, scaling, and the OSS/monetization model.

## Contributing

Trunk-based development, short-lived branches, squash-merged PRs. See the [Branching & Git Workflow](https://github.com/AKogut/flakemetry/wiki/Branching-and-Git-Workflow) guide. Good first issues are labelled in the [issue tracker](https://github.com/AKogut/flakemetry/issues).

## Tech stack

TypeScript · Playwright · Node.js · PostgreSQL (Prisma) · React / Next.js · Docker · GitHub Actions · OpenTelemetry

## License

[MIT](./LICENSE) © Andrii Kohut
