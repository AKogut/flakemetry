# Query benchmark

Seeds one project inside Postgres and times the query functions the dashboard, the API and
the CLI call. [ADR-0005](../../../docs/adr/0005-executions-stay-in-postgres.md) records the
results and what was decided from them.

## Run it

A dedicated Postgres, sized like a small production instance. `--shm-size` matters: Docker's
default 64 MB `/dev/shm` is too small for parallel aggregation over 15 M rows.

```bash
docker run -d --name fm-bench-pg --cpus 2 --memory 4g --shm-size 2g -p 55433:5432 \
  -e POSTGRES_USER=bench -e POSTGRES_PASSWORD=bench -e POSTGRES_DB=bench \
  postgres:16-alpine -c shared_buffers=1GB -c effective_cache_size=3GB -c work_mem=16MB \
  -c maintenance_work_mem=512MB -c max_wal_size=4GB -c random_page_cost=1.1

export DATABASE_URL='postgresql://bench:bench@localhost:55433/bench?schema=public'
pnpm --filter @flakemetry/db exec prisma migrate deploy

docker exec -i fm-bench-pg psql -U bench -d bench \
  -v tests=2000 -v runs_per_day=25 -v days=30 < packages/queries/bench/seed.sql

pnpm turbo run build --filter @flakemetry/queries
node packages/queries/bench/run.mjs
```

| Variable | Meaning |
| --- | --- |
| `tests` | Tests in the suite; every run executes each once, plus retries |
| `runs_per_day` | CI runs a day; one in five is on a feature branch |
| `days` | Days of history |

`tests=2000 runs_per_day=25 days=30` is 1.5 M executions and seeds in under a minute.
Multiply either of the first two by ten for the 10× volumes; those take about eight minutes
each. `BENCH_ITERATIONS` sets the timed repetitions per query (default 20).
