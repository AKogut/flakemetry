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

notifications:
  channels:
    - kind: slack
      target: https://hooks.slack.com/services/T/B/x
      events: [flaky_detected, suite_regressed]
    - kind: email
      target: alerts@acme.com
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
| `notifications.channels` | array | `[]` | Notification channels declared in code. Each is `{ kind: slack \| discord \| email, target, events? }` — `target` is a webhook URL (Slack/Discord) or address (email); `events` filters by type (default: all). Synced to the project on each run and shown read-only in **Settings → Notifications** alongside dashboard-added channels. |

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
| `FLAKEMETRY_CI_MINUTE_COST` | `cost.ciMinute` |
| `FLAKEMETRY_DEVELOPER_HOUR_COST` | `cost.developerHour` |
| `FLAKEMETRY_INVESTIGATION_MINUTES` | `cost.investigationMinutes` |
| `FLAKEMETRY_TRACKER_TOKEN` | Tracker credentials (no default — the feature is off without it) |
| `FLAKEMETRY_TRACKER_ENABLED` | `tracker.enabled` |
| `FLAKEMETRY_TRACKER_AFTER_DAYS` | `tracker.afterDays` |
| `FLAKEMETRY_TRACKER_RECOVERY_DAYS` | `tracker.recoveryDays` |
| `FLAKEMETRY_PUBLIC_API_URL` | Base URL printed in badge snippets |

### Reporter transport (Playwright)

| Variable | Effect |
|---|---|
| `FLAKEMETRY_TRANSPORT` | `otlp` (default) or `json` |
| `FLAKEMETRY_BUFFER_DIR` | Directory to buffer runs to when delivery fails; replayed on the next run |
| `FLAKEMETRY_SAMPLE_RATE` | Fraction (0–1) of **passing** runs to deliver; runs containing a failure or flake are always delivered |
| `FLAKEMETRY_COMPRESSION` | `gzip` to compress OTLP export (the ingestion API decompresses gzip request bodies) |
| `FLAKEMETRY_COMMIT_SHA` | Commit the run belongs to, when CI detection cannot find it — a run without one lands on `0000000`, and every run on that placeholder looks like the same commit to the scorer |
| `FLAKEMETRY_BRANCH` | Branch the run belongs to, same case; the fallback is `local` |
| `FLAKEMETRY_SHARD_INDEX` / `FLAKEMETRY_SHARD_TOTAL` | Shard position when the runner shards in a way detection does not recognise. Both are needed; a total of 1 is treated as unsharded |
| `FLAKEMETRY_CODEOWNERS_FILE` | Explicit path to a CODEOWNERS file to sync; otherwise the reporter looks for `CODEOWNERS`, `.github/CODEOWNERS`, or `docs/CODEOWNERS` walking up from the test root |
| `FLAKEMETRY_IDEMPOTENCY_KEY` | Explicit idempotency key for the run; makes re-delivery safe. Defaults to the run span trace id. Sharded runs get a per-shard `-shard<index>` suffix automatically |

The reporter also syncs the repo's CODEOWNERS to the project on each run, so the flaky board and per-owner filters attribute each test to its owning team or user.

### Ingestion API service

| Variable | Effect |
|---|---|
| `LOG_LEVEL` | Structured (pino) log level; `authorization` header is redacted |
| `FLAKEMETRY_MAX_QUEUE_DEPTH` | Backpressure threshold — return `503` once pending jobs reach it. Defaults to `10000`; set `0` to disable |
| `FLAKEMETRY_SELF_OTEL_ENDPOINT` | OTLP endpoint to export the API's own metrics to (dogfooding); metrics are no-ops when unset |

The API also rate-limits per project token (fixed window) and returns `429` with `Retry-After` when exceeded.

Rate-limit and backpressure state are held per API process (in-memory). Running multiple API replicas multiplies the effective limits — each replica counts only its own traffic — so front them with a shared gateway limiter if you need a cluster-wide cap.

### Processing worker

| Variable | Effect |
|---|---|
| `POLL_INTERVAL_MS` | Idle poll interval between dequeue attempts |
| `FLAKEMETRY_SELF_OTEL_ENDPOINT` | OTLP endpoint for the worker's own metrics (processing lag, throughput, error rate, queue depth) |
| `FLAKEMETRY_CLUSTER_THRESHOLD` | Jaccard similarity (0–1) above which a new error signature joins an existing cluster (default `0.5`) |
| `FLAKEMETRY_QUEUE_VISIBILITY_MS` | How long a dequeued job stays invisible to other workers before it is redelivered (default `300000`). Raise it only if a single run legitimately takes longer than this to process — lowering it below the slowest job causes the same run to be processed twice |
| `FLAKEMETRY_EXECUTION_RETENTION_DAYS` / `FLAKEMETRY_ARTIFACT_RETENTION_DAYS` | Global retention floor for projects with no per-project policy; see [Trend rollups and retention](#trend-rollups-and-retention) |

The worker emits domain events (`run.processed`, `identity.created`, `identity.moved`, `score.updated`, `flaky.detected`, `quarantine.changed`, `suite.regressed`, `suite.slowed`, `rca.created`) after each job commits — the seam downstream stages such as signature clustering, AI RCA, and notifications subscribe to.

### AI root-cause analysis

`ai.rca` turns the feature on; these decide what it talks to. Setting `FLAKEMETRY_AI_RCA=true`
without a provider gets you nothing — the worker has nothing to ask.

| Variable | Effect |
|---|---|
| `FLAKEMETRY_AI_PROVIDER` | `anthropic` or `ollama`. Unset means RCA stays off however `ai.rca` is set |
| `FLAKEMETRY_AI_API_KEY` | Provider credentials. `ANTHROPIC_API_KEY` is also read, so an existing environment works unchanged |
| `FLAKEMETRY_AI_MODEL` | Model id; each provider has a sensible default |
| `FLAKEMETRY_AI_ENDPOINT` | Base URL, for a self-hosted Ollama or a proxy |
| `FLAKEMETRY_AI_TIMEOUT_MS` | Per-request ceiling. RCA is best-effort — a slow provider must not hold up processing |

Spend is bounded by `ai.dailyTokenBudget` per project, and only genuinely new error
signatures reach the model at all; the rest are answered from the cluster's cached analysis.

### Notifications

The worker pushes intelligence to Slack, Discord and email. Webhook delivery is best-effort and de-duplicated per channel so a flapping test can't spam a channel. Channels come from two places, applied together: **global env channels** (below) and **per-project channels** configured in **Settings → Notifications** (add a Slack/Discord webhook or an email address with an event filter). Events: `flaky_detected`, `quarantine_changed`, `rca_ready`, `suite_regressed` (a suite's fail-rate crossing its trailing baseline), and `suite_slowed` (a suite's average duration rising well above its trailing baseline).

| Variable | Effect |
|---|---|
| `FLAKEMETRY_SLACK_WEBHOOK` | Global Slack incoming-webhook URL to post to (applies to every project) |
| `FLAKEMETRY_DISCORD_WEBHOOK` | Global Discord webhook URL to post to |
| `FLAKEMETRY_EMAIL_TO` | Global recipient address for email notifications (requires `FLAKEMETRY_SMTP_*` below) |
| `FLAKEMETRY_NOTIFY_EVENTS` | Comma-separated event filter for the global channels (default: all) |
| `FLAKEMETRY_DASHBOARD_URL` | Public dashboard base URL, used to deep-link notifications back to the test |

Email delivery (global recipient and per-project email channels) needs an SMTP relay:

| Variable | Effect |
|---|---|
| `FLAKEMETRY_SMTP_HOST` | SMTP server host — enables email delivery when set together with a from address |
| `FLAKEMETRY_SMTP_FROM` | Envelope/from address for outgoing mail |
| `FLAKEMETRY_SMTP_PORT` | SMTP port (default `587`; `465` implies TLS) |
| `FLAKEMETRY_SMTP_SECURE` | `true` to force an implicit-TLS connection |
| `FLAKEMETRY_SMTP_USER` / `FLAKEMETRY_SMTP_PASS` | SMTP credentials, when the relay requires auth |

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
| `FLAKEMETRY_EXECUTION_RETENTION_DAYS` | Global default: worker prunes raw executions older than this on a periodic sweep; rollups are untouched. Unset keeps every execution |
| `FLAKEMETRY_ARTIFACT_RETENTION_DAYS` | Global default for artifact pruning (also under Artifact storage above) |

Retention is resolved **per project**: a project can set its own execution/artifact retention in **Settings → Policy**, which overrides the global env default (blank inherits it). The worker sweeps each project at its own window, and artifact retention is always clamped to at least the execution window so signed refs never outlive their objects.

Recompute is idempotent: re-delivering a run recomputes the same day's aggregates rather than double-counting.

## Inspecting the resolved configuration

```bash
npx @flakemetry/cli config
npx @flakemetry/cli config --json
```

Prints the config file in use (if any), whether a token is present (redacted), and the fully resolved configuration after all layers.
