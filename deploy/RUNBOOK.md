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

### Measured throughput

One worker against a local Postgres, a run of previously unseen tests — the worst case,
since every one needs an identity created and a first score:

| executions in one run | processed in | queries issued |
| --- | --- | --- |
| 1000 | 0.6s | 28 |
| 3000 | 3.3s | 28 |
| 5000 | 8.4s | 28 |

The query count is the number to watch. It is flat because nothing in the pipeline does
work per test any more, and `apps/worker/src/__tests__/throughput.test.ts` fails if that
changes — it ingests at two sizes and asserts the count does not grow with them.

**It counts round trips, not milliseconds, on purpose.** A wall-clock threshold on a shared
CI runner is itself a flaky test, which would be a poor thing to ship from a product about
flaky tests, and it would measure the runner rather than the code. Query count is
deterministic on any hardware and catches the regression that matters: work that scales
with the size of the suite.

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

Postgres is the system of record — the queue, all history, identities, and scores. Object
storage holds only artifacts, which degrade the UI when lost but never the intelligence.

### Targets

| | | |
| --- | --- | --- |
| **RPO** | one backup interval | Hourly `backup.sh` loses at most an hour of runs; a managed provider's point-in-time recovery brings this to seconds and is the better answer where it is available |
| **RTO** | minutes | `pg_restore` of a single-digit-gigabyte dump, plus the time to start three stateless services |

Both assume the dump is somewhere other than the machine that died. Nothing here copies it
off the box for you.

### Taking one

```bash
sh deploy/backup/backup.sh /var/backups/flakemetry
```

Custom format, not plain SQL: it restores selectively and refuses to load into a schema it
does not match, where a plain dump half-applies and looks like it worked. The script
refuses to keep a dump under a kilobyte, because that is what `pg_dump` writes when it
reaches nothing, and rotates to the last 14 (`FLAKEMETRY_BACKUP_KEEP`).

Put it on a timer and ship the result off the host:

```
0 * * * * cd /opt/flakemetry && sh deploy/backup/backup.sh /var/backups/flakemetry
```

### Restoring

```bash
sh deploy/backup/restore.sh /var/backups/flakemetry/flakemetry-20260818T101500Z.dump
sh deploy/backup/verify.sh
```

This **replaces** the database. `restore.sh` stops the services that write first, loads in a
single transaction so a failure leaves the old state rather than half the new one, and
starts them again. Restoring over a freshly migrated database is fine — the drop is part of
the same transaction.

`verify.sh` prints row counts per table. Run it before the backup and after the restore and
compare: a dump that loaded without error and a dump that carried the data are different
claims, and only counts tell them apart.

### The drill

`.github/workflows/backup.yml` runs the whole path on every change: boot, write a marker
row, back up, **destroy the volume**, bring the stack back, restore, and check the marker
returned and every table count matches.

It asserts the marker is *gone* after the volume is destroyed before claiming it was
recovered. Without that step a drill where the volume quietly survived would pass, and so
would one where the restore did nothing — the seeded database looks much like the backed-up
one, which is exactly how this check was found to be necessary.

### Artifact grants are bounded

A presigned upload is issued for a specific key, content type and **size**. A body that does
not match the declared `sizeBytes` is refused with `403`, so a grant meant for a screenshot
cannot be spent on a gigabyte — read a `403` there as the limit working, not as a
misconfiguration.

## Platform observability

Flakemetry is OpenTelemetry-native and should dogfood its own telemetry: api and worker
export traces/metrics so ingestion latency, queue lag, and processing throughput are
first-class dashboards. Reference OTel dashboards and alert rules are a tracked follow-up.
