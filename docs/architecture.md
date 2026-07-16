# Architecture

Flakemetry is a layered, event-driven platform with one governing constraint: **ingestion never blocks CI** (ADR-0004). This document is the code-adjacent architecture reference; deeper product context lives in the [wiki](https://github.com/AKogut/flakemetry/wiki).

## System overview

```
┌──────────────────────────────────────────────────────────────────────┐
│  INGESTION EDGE                                                        │
│  @flakemetry/playwright-reporter · OTLP endpoint · GitHub Action       │
└────────────┬───────────────────────────────────────────────────────────┘
             │  OTLP/HTTP (ADR-0002), zstd, idempotency key per run
             ▼
┌──────────────────────────────────────────────────────────────────────┐
│  INGESTION API  (apps/api)                                             │
│  authenticate → validate against contracts → enqueue → 202            │
└────────────┬───────────────────────────────────────────────────────────┘
             ▼  durable queue: Postgres FOR UPDATE SKIP LOCKED (ADR-0004)
┌──────────────────────────────────────────────────────────────────────┐
│  WORKERS  (apps/worker)                                                │
│  normalize spans → resolve test identity → update flaky score         │
│  → cluster failure signature → trigger AI RCA (async, budget-gated)   │
└────────────┬───────────────────────────────────────────────────────────┘
             ▼
┌──────────────────────────────────────────────────────────────────────┐
│  STORAGE                                                               │
│  PostgreSQL: relational core + JSONB + rollups   (packages/db)        │
│  S3/MinIO: artifacts (screenshots, videos, traces)                    │
└────────────┬───────────────────────────────────────────────────────────┘
             ▼
┌──────────────────────────────────────────────────────────────────────┐
│  QUERY API (tRPC/REST)  →  DASHBOARD (apps/web)                       │
└──────────────────────────────────────────────────────────────────────┘
```

## Data flow

1. A reporter emits OTel spans per the test semantic conventions and exports OTLP/HTTP with a per-run idempotency key.
2. `apps/api` authenticates the project token, validates the payload against `@flakemetry/contracts`, enqueues it and ACKs `202` immediately.
3. `apps/worker` dequeues with `SKIP LOCKED`, materializes `run` and `test_execution` rows, resolves the stable test identity, incrementally updates the flaky score (ADR-0003) and clusters the failure signature.
4. New failure signatures trigger asynchronous, budget-gated AI root-cause analysis; known signatures reuse the cached report at zero cost.
5. The dashboard reads through the typed query API, hitting rollups rather than raw executions for trends.

## Workspace map

| Workspace | Role | Published |
|---|---|---|
| `packages/contracts` | zod schemas: entities, ingestion payloads, query DTOs — single source of truth | yes |
| `packages/core` | pure domain logic: test identity, flaky scoring; no I/O | yes |
| `packages/db` | Prisma schema, migrations, seed, client singleton | no |
| `packages/sdk` | OTel test instrumentation + ingest client | yes |
| `packages/reporter` | `@flakemetry/playwright-reporter` | yes |
| `packages/ai` | LLM provider abstraction + RCA pipeline | yes |
| `packages/cli` | command line interface | yes |
| `apps/api` | ingestion + query service | no |
| `apps/worker` | queue consumers / processing stages | no |
| `apps/web` | dashboard | no |

Dependency direction is strictly downward: apps depend on packages, packages depend on `contracts`, nothing depends on apps.

## Load-bearing decisions

| Decision | Record |
|---|---|
| Monorepo: pnpm workspaces + Turborepo, contracts as shared source of truth | [ADR-0001](adr/0001-monorepo-pnpm-turborepo.md) |
| OTel-native ingestion, tests as traces | [ADR-0002](adr/0002-otel-native-ingestion.md) |
| Explainable statistical flaky scoring, no black-box ML | [ADR-0003](adr/0003-explainable-flaky-scoring.md) |
| Async ingestion: 202 + durable Postgres queue | [ADR-0004](adr/0004-async-ingestion-202-queue.md) |

New load-bearing decisions require a new ADR from [the template](adr/template.md); superseded decisions are marked, never deleted.

## Cross-cutting rules

- **Multi-tenancy from day one**: `org_id` and `project_id` on every table, indexed, even in single-tenant self-host.
- **Storage seams**: the span store and the queue sit behind interfaces so columnar storage and a real broker can slot in at scale without touching core.
- **Fail open at the edge**: reporters and the GitHub Action never fail a CI job because Flakemetry is unreachable.
- **Provider-agnostic AI**: hosted or local models are a config change, never a code change.
