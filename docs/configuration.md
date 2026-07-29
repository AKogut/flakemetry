# Configuration

Flakemetry is configured through `flakemetry.yml` at the repository root (config-as-code, reviewable in PRs), with two override layers on top.

## Precedence

```
flakemetry.yml  <  project settings (dashboard)  <  environment variables
```

Later layers win per key; nested objects merge deep, arrays replace.

## flakemetry.yml

```yaml
project: acme/web
endpoint: https://ingest.flakemetry.example.com

flaky:
  threshold: 0.8
  minSamples: 5

quarantine:
  enabled: false
  cooldownRuns: 20

ai:
  rca: true
  dailyTokenBudget: 200000

ignore:
  - '**/*.setup.ts'

retention:
  rawDays: 90
```

## Options

| Key | Type | Default | Description |
|---|---|---|---|
| `project` | string | — | Project slug the results belong to |
| `endpoint` | url | — | Ingestion endpoint |
| `flaky.threshold` | number 0..1 | `0.8` | Flaky score above which a test becomes a quarantine candidate |
| `flaky.minSamples` | int ≥ 1 | `5` | Minimum executions before a score is trusted |
| `quarantine.enabled` | boolean | `false` | Allow automatic quarantining of flaky tests |
| `quarantine.cooldownRuns` | int ≥ 1 | `20` | Clean runs required before automatic un-quarantine |
| `ai.rca` | boolean | `true` | Enable AI root-cause analysis |
| `ai.dailyTokenBudget` | int ≥ 0 | `200000` | Per-project daily LLM token cap; RCA pauses when exceeded |
| `ignore` | string[] | `[]` | Glob patterns of test files excluded from analysis |
| `retention.rawDays` | int ≥ 1 | `90` | Days raw executions are kept; rollups live longer |

Unknown keys are rejected with an error naming the offending path — typos fail fast instead of being silently ignored.

## Environment variables

| Variable | Overrides |
|---|---|
| `FLAKEMETRY_TOKEN` | Ingest token (never put tokens in the file) |
| `FLAKEMETRY_PROJECT` | `project` |
| `FLAKEMETRY_ENDPOINT` | `endpoint` |
| `FLAKEMETRY_FLAKY_THRESHOLD` | `flaky.threshold` |
| `FLAKEMETRY_FLAKY_MIN_SAMPLES` | `flaky.minSamples` |
| `FLAKEMETRY_QUARANTINE_ENABLED` | `quarantine.enabled` |
| `FLAKEMETRY_QUARANTINE_COOLDOWN_RUNS` | `quarantine.cooldownRuns` |
| `FLAKEMETRY_AI_RCA` | `ai.rca` |
| `FLAKEMETRY_AI_DAILY_TOKEN_BUDGET` | `ai.dailyTokenBudget` |

### Reporter transport (Playwright)

| Variable | Effect |
|---|---|
| `FLAKEMETRY_TRANSPORT` | `otlp` (default) or `json` |
| `FLAKEMETRY_BUFFER_DIR` | Directory to buffer runs to when delivery fails; replayed on the next run |
| `FLAKEMETRY_SAMPLE_RATE` | Fraction (0–1) of **passing** runs to deliver; runs containing a failure or flake are always delivered |
| `FLAKEMETRY_COMPRESSION` | `gzip` to compress OTLP export (the ingestion API decompresses gzip request bodies) |

### Ingestion API service

| Variable | Effect |
|---|---|
| `LOG_LEVEL` | Structured (pino) log level; `authorization` header is redacted |
| `FLAKEMETRY_MAX_QUEUE_DEPTH` | Backpressure threshold — return `503` once pending jobs reach it |
| `FLAKEMETRY_SELF_OTEL_ENDPOINT` | OTLP endpoint to export the API's own metrics to (dogfooding); metrics are no-ops when unset |

The API also rate-limits per project token (fixed window) and returns `429` with `Retry-After` when exceeded.

### Processing worker

| Variable | Effect |
|---|---|
| `POLL_INTERVAL_MS` | Idle poll interval between dequeue attempts |
| `FLAKEMETRY_SELF_OTEL_ENDPOINT` | OTLP endpoint for the worker's own metrics (processing lag, throughput, error rate, queue depth) |

The worker emits domain events (`run.processed`, `identity.created`, `identity.moved`, `score.updated`) after each job commits — the seam downstream stages such as signature clustering and AI RCA subscribe to.

### Artifact storage

Screenshots, video, traces, and HAR files are stored in an S3-compatible object store. The reporter requests a presigned upload URL from the API (`POST /v1/artifacts/presign`, ingest-token auth, content-type and size validated) and uploads each file directly to the store; the stored object key is carried on the execution's artifact refs. The dashboard serves them back through short-lived signed download URLs. The pipeline is off until a bucket is configured.

| Variable | Effect |
|---|---|
| `FLAKEMETRY_S3_BUCKET` | Bucket for artifacts. Unset disables the pipeline (`/v1/artifacts/presign` returns `501`) |
| `FLAKEMETRY_S3_ENDPOINT` | S3 endpoint. Point at MinIO for self-host; unset for AWS S3 |
| `FLAKEMETRY_S3_PUBLIC_ENDPOINT` | Browser-reachable host the dashboard mints download URLs against |
| `FLAKEMETRY_S3_REGION` | Region (default `us-east-1`) |
| `FLAKEMETRY_S3_ACCESS_KEY_ID` / `FLAKEMETRY_S3_SECRET_ACCESS_KEY` | Credentials (fall back to the standard `AWS_*` names) |
| `FLAKEMETRY_S3_FORCE_PATH_STYLE` | `true` for MinIO; defaults on when an endpoint is set |
| `FLAKEMETRY_ARTIFACT_RETENTION_DAYS` | Worker prunes objects older than this on a periodic sweep; unset keeps everything |

`docker compose up` wires the bundled MinIO to all of these automatically — nothing to set for a local stack.

### Trend rollups and retention

Daily aggregates are materialized on ingest — the worker recomputes `daily_test_stats`, `suite_daily`, and `flaky_trends` for the affected day after each run, so trend queries read pre-aggregated rows rather than scanning raw executions. Because the rollups are the source of truth for trends, raw executions can be kept on a short horizon while aggregates persist.

| Variable | Effect |
|---|---|
| `FLAKEMETRY_EXECUTION_RETENTION_DAYS` | Worker prunes raw executions older than this on a periodic sweep; rollups are untouched. Unset keeps every execution |

Recompute is idempotent: re-delivering a run recomputes the same day's aggregates rather than double-counting.

## Inspecting the resolved configuration

```bash
npx @flakemetry/cli config
npx @flakemetry/cli config --json
```

Prints the config file in use (if any), whether a token is present (redacted), and the fully resolved configuration after all layers.
