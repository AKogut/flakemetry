# Flakemetry operations runbook

Operating a hosted or serious self-hosted Flakemetry instance: what to run, what to watch,
and what to do when it breaks. Deployment is via the [Helm chart](helm/flakemetry), against
a managed Postgres and an S3-compatible object store.

## Architecture recap

Three workloads, one governing constraint — **ingestion never blocks CI**:

- **api** — validates and enqueues runs, returns `202` immediately. Stateless; scales
  horizontally behind an HPA.
- **worker** — drains the Postgres-backed queue (`SKIP LOCKED`) and runs identity, flaky
  scoring, signature clustering, and AI RCA. Stateless; scales horizontally.
- **web** — Next.js dashboard and query API. Stateless.

Managed dependencies: **Postgres** (relational + JSONB, pgvector for RCA) and an
**object store** (artifacts). The queue is a table in Postgres, so there is no separate
broker to run.

## Service level objectives

| SLO                          | Target                        | Measured by                                   |
| ---------------------------- | ----------------------------- | --------------------------------------------- |
| Ingestion availability       | 99.9% of `POST /v1/ingest`    | non-5xx responses / total                     |
| Ingestion latency            | p99 `< 300ms` (enqueue only)  | api request duration                          |
| Processing lag               | p95 run processed `< 60s`     | worker dequeue-to-complete                    |
| Dashboard availability       | 99.5%                         | non-5xx on web health + key queries           |
| Data durability              | no acknowledged run lost      | queue depth vs. processed count reconciliation |

The ingestion SLO is the important one: the `202` contract means a CI pipeline must never
wait on Flakemetry. Everything downstream (scoring, RCA) is allowed to lag under load and
catch up.

## Error budget policy

- Ingestion availability burns from a **0.1%** monthly budget. If a rolling 1-hour burn
  would exhaust more than 5% of the month's budget, page.
- Processing lag is a **latency** objective, not availability: sustained lag drains no
  budget as long as the queue is draining. Alert (do not page) when p95 lag exceeds 60s for
  10 minutes; page only if the queue depth is monotonically increasing for 30 minutes
  (workers not keeping up — see below).

## Scaling

Ingestion and processing scale independently:

- **api** and **worker** ship with HPAs (CPU-target) in the chart. Ingestion spikes with CI
  volume; processing spikes with backlog. Because the queue is durable, the worker fleet can
  lag and recover without data loss.
- Raise `worker.autoscaling.maxReplicas` when queue depth is the bottleneck; raise
  `api.autoscaling.maxReplicas` when ingestion latency is. Watch Postgres connection count
  as you scale workers — each worker holds a small pool, so cap replicas below the
  database's `max_connections` (or front it with a pooler such as PgBouncer).

## Common operations

### Deploy / upgrade

```bash
helm upgrade --install flakemetry deploy/helm/flakemetry \
  -n flakemetry --create-namespace \
  -f deploy/helm/example-values.yaml
```

Migrations run as a **pre-install/pre-upgrade hook** (`prisma migrate deploy`) before the
new pods roll. Migrations are additive by design, so a rolling upgrade never requires
downtime. The hook never seeds — production data is untouched.

### Roll back

```bash
helm rollback flakemetry -n flakemetry
```

Because migrations are additive and backward-compatible, rolling the app back one release
is safe without a schema rollback.

### Inspect the queue

Processing lag almost always traces to the queue. Check depth and the oldest unprocessed
job in Postgres, and confirm workers are running and not crash-looping
(`kubectl get pods -l app.kubernetes.io/component=worker`).

## Runbook: symptoms → actions

| Symptom                              | Likely cause                          | Action                                                                 |
| ------------------------------------ | ------------------------------------- | ---------------------------------------------------------------------- |
| `202` latency rising, 5xx on ingest  | api saturated or DB writes slow       | Confirm api HPA scaled; check DB CPU/connections; raise api max replicas |
| Queue depth climbing, lag rising     | worker fleet undersized or stuck      | Check worker pods healthy; raise worker max replicas; check DB pool     |
| Migrations hook failing on upgrade   | bad migration or DB unreachable       | Read the migrate Job logs; fix connectivity; migrations are idempotent  |
| Dashboard 5xx                        | web ↔ DB or web ↔ object store issue  | Check web pod logs; verify S3 public endpoint reachable from browser    |
| Artifacts 404 in the UI              | wrong `storage.publicEndpoint`        | Set a browser-reachable public endpoint; re-check bucket CORS           |
| AI RCA silent                        | budget spent or provider misconfigured | Expected once the daily token budget is spent; else check provider/key  |

## Backups & disaster recovery

Postgres is the system of record — the queue, all history, identities, and scores live
there. Object storage holds only artifacts (screenshots, video, traces), which are
regenerable. Back up Postgres with your managed provider's point-in-time recovery; artifact
loss degrades the UI but never the intelligence. Full backup/DR automation is tracked on
the [roadmap](https://github.com/users/AKogut/projects/14).

## Platform observability

Flakemetry is OpenTelemetry-native and should dogfood its own telemetry: api and worker
export traces/metrics so ingestion latency, queue lag, and processing throughput are
first-class dashboards. Reference OTel dashboards and alert rules are a tracked follow-up.
