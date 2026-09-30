# ADR-0005: Executions and spans stay in Postgres

- **Status**: accepted
- **Date**: 2026-09-30

## Context

Every test execution is a row in `test_execution`, and its spans are a JSONB column on that
row. The roadmap assumed that span-level, high-cardinality data would eventually need a
columnar store (ClickHouse or Timescale) behind the query layer, and #50 asked for the
benchmark that would decide it: do the dashboard's queries meet their latency targets at 10
to 100 times the volume of a typical project?

The target used here: a page's queries answer in **under 300 ms at p95**, matching the
ingestion latency objective in the runbook.

## What was measured

[`packages/queries/bench`](../../packages/queries/bench) seeds a project inside Postgres and
runs the query functions the dashboard, the API and the CLI call, 20 times each after a
warm-up. The database was Postgres 16 in a container limited to 2 CPUs and 4 GB, with
`shared_buffers` at 1 GB, about a `db.t4g.medium`.

| | tests | runs a day | days | executions | table + indexes |
| --- | ---: | ---: | ---: | ---: | ---: |
| **1×** | 2,000 | 25 | 30 | 1.5 M | 0.7 GB |
| **10× runs** | 2,000 | 250 | 30 | 15.2 M | 7.1 GB |
| **10× tests** | 20,000 | 25 | 30 | 15.2 M | 6.6 GB |

Each run fails about 0.5% of tests, and 5% of tests are flaky, failing a fifth of the time
and passing on retry. One execution in ten carries spans. Scores, health events, error
signatures and the daily rollups are generated to match.

p95 in milliseconds:

| query | 1× | 10× runs | 10× tests |
| --- | ---: | ---: | ---: |
| trace, one execution with its spans | 1.5 | 1.4 | 2.0 |
| test detail, 60 runs of history | 2.5 | 2.5 | 2.3 |
| flake bisect | 2.0 | 2.9 | 2.2 |
| flaky board | 2.9 | 3.0 | 3.0 |
| error cluster, cluster impact | 0.8 | 0.9 | 1.0 |
| suite health, flaky trend | 2.1 | 1.8 | 2.0 |
| test health, team health | 3.5 | 3.2 | 24.1 |
| run summary by commit, PR gate | 13.5 | 11.3 | 129.0 |
| run detail | 15.4 | 14.0 | 141.4 |
| **runs list** | 23.5 | 9.3 | **4,760** |
| health KPIs | 39.6 | 35.5 | **373** |
| daily trend | 65.8 | 59.6 | **586** |
| leaderboards | 95.6 | 99.6 | **1,301** |
| cost of flakiness | 185.6 | 189.3 | **2,433** |
| **usage page** | 77.2 | **6,588** | **4,157** |
| **retention count** | 70.8 | **6,168** | **3,614** |

## Decision

Executions and their spans stay in Postgres. No columnar store is introduced.

Spans are only ever read one execution at a time, by primary key, for the trace waterfall.
That query takes 1–2 ms at every volume measured. No feature aggregates across spans, so a
columnar store would add an operational dependency, a dual-write path and a backfill
without any query to serve. The same holds for everything else bounded by a test, a run
or an execution. History, bisect, the flaky board and clusters use their indexes and
limits, and did not move between 1.5 M and 15 M rows.

What did not scale are three aggregations done at read time over sets that grow with the
project:

1. **Per-run status counts on the runs list.** Each page counts the executions of 20 runs,
   so the cost is the suite size times the page. It holds at 2,000 tests and takes 4.8 s at
   20,000.
2. **Rollup panels summed in JavaScript.** Cost, leaderboards, the daily trend and the KPIs
   fetch one row per test per day and add them up in the application. That is 60,000 rows
   at 1× and 600,000 at 10× tests, so the cost panel reaches 2.4 s.
3. **Exact whole-project counts.** The usage page and the storage cap count every
   execution of the project. At 15 M rows the table no longer fits in memory, and the
   count takes 6 s.

None of these is a storage-engine problem. A columnar engine would make the scans faster;
not scanning is faster still. Each has a fix inside the current schema:

1. Store a run's counts when the worker processes it.
2. Aggregate rollups in SQL.
3. Keep a running count per project instead of counting.

## Alternatives considered

- **ClickHouse for executions and spans.** It fits analytical scans over billions of rows.
  But the only slow queries here scan because of how they are written. A second datastore
  would also break the one-command self-host, the transactional write of a run, and the
  tenant erasure, which today is verified by querying one database.
- **TimescaleDB hypertables.** The smaller step, since it is still Postgres. Chunking
  mainly helps retention: dropping a day's chunk instead of deleting rows. That is worth
  revisiting when retention deletes become the bottleneck. It does nothing for the three
  queries above.
- **Native partitioning of `test_execution` by month.** Same trade as Timescale without the
  extension. It is the first thing to try if retention sweeps fall behind, and it needs
  no change behind the query layer.

## Consequences

- The three aggregations are #357 (runs list), #358 (rollup panels) and #359 (project
  counts), each with the numbers above as its acceptance bar.
- The benchmark stays in the repository. Rerun it when a query that reads executions is
  added or changed: `packages/queries/bench/README.md` has the commands.
- Revisit this decision when any of these becomes true:
  - a feature needs to aggregate across spans or executions without a bound, such as the
    slowest HTTP calls across all runs;
  - one project retains more than about 100 M executions;
  - retention sweeps cannot keep up with ingestion.
