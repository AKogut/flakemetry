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

## Inspecting the resolved configuration

```bash
npx @flakemetry/cli config
npx @flakemetry/cli config --json
```

Prints the config file in use (if any), whether a token is present (redacted), and the fully resolved configuration after all layers.
