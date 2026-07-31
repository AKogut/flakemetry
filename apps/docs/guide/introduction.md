# Introduction

Test tooling is stuck. Three systemic gaps:

- **Tests are report artifacts, not telemetry.** JUnit XML and HTML reports capture _one_
  run — no history, no trace context, no correlation with application signals.
- **Flaky detection is primitive.** Most teams "detect" flakes by eyeballing
  `retries > 0`. No stable identity across refactors, no statistical model, no
  auto-quarantine.
- **Root-cause is manual archaeology.** Every failure means digging through logs, stack
  traces, screenshots, and git blame — 20–40 minutes an incident.

Flakemetry closes all three by modelling every test execution as an OpenTelemetry span.

## What you get

| Capability                | What it means                                                                     |
| ------------------------- | --------------------------------------------------------------------------------- |
| **Test observability**    | Every run ingested as OTLP; full history per test, not per report                 |
| **Stable test identity**  | Fingerprints that survive file moves, renames, and parameterization               |
| **Explainable scoring**   | A transparent Bayesian flaky score with human-readable reason codes               |
| **AI root-cause**         | Structured "likely cause + suggested action", budget-gated, provider-agnostic     |
| **CI-native**             | GitHub Action + sticky PR comment; never blocks your build                        |
| **Self-hostable**         | One `docker compose up`, MIT-licensed core                                         |

## The 60-second path

1. [**Self-host**](/guide/self-hosting) — `docker compose up` brings the whole stack up
   locally, seeded with demo runs.
2. [**Send a run**](/guide/reporters) — drop in a reporter, or upload
   [JUnit XML from any runner](/guide/junit).
3. [**Read your first insight**](/guide/first-insight) — the flaky board ranks every test
   by a transparent score, worst first, with the reason codes behind it.

## How it fits together

```
 reporter / OTLP / GitHub Action
              │  OTLP-HTTP (JSON), idempotency-key
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

The write path returns `202` instantly and does the heavy work asynchronously —
**ingestion never blocks CI**. See [Architecture](/concepts/architecture) for the full
design.
