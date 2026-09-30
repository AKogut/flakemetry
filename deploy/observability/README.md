# Watching Flakemetry

The api and worker export their own metrics over OTLP when `FLAKEMETRY_SELF_OTEL_ENDPOINT`
is set. This directory holds what turns them into the SLOs in
[`../RUNBOOK.md`](../RUNBOOK.md): alert rules, their tests, and a dashboard.

| File | What it is |
| --- | --- |
| [`otel-collector.yaml`](otel-collector.yaml) | Receives OTLP on 4318 (HTTP) and 4317 (gRPC) and forwards metrics to Prometheus's OTLP receiver. Add exporters here to send the same metrics elsewhere |
| [`prometheus.yml`](prometheus.yml) | Loads the rules. Run Prometheus with `--web.enable-otlp-receiver` |
| [`rules/flakemetry.rules.yml`](rules/flakemetry.rules.yml) | Recording rules for the SLIs and the alerts listed in the runbook |
| [`rules/flakemetry.rules.test.yml`](rules/flakemetry.rules.test.yml) | `promtool test rules` cases: each alert fires when it should and stays quiet when it should not |
| [`grafana/dashboards/flakemetry.json`](grafana/dashboards/flakemetry.json) | The **Flakemetry platform** dashboard. It picks its Prometheus through a variable, so it imports into any Grafana |
| [`verify.mjs`](verify.mjs) | Checks a running Prometheus: the core metrics exist, every rule evaluates, every panel query runs |

## Run it next to the quickstart

```bash
FLAKEMETRY_SELF_OTEL_ENDPOINT=http://otel-collector:4318 OTEL_METRIC_EXPORT_INTERVAL=5000 \
  docker compose --profile observability up -d
```

Prometheus is on `http://localhost:9090` and Grafana on `http://localhost:3001`, both bound
to loopback like the rest of the quickstart. To run the api and worker from source instead,
use `FLAKEMETRY_SELF_OTEL_ENDPOINT=http://localhost:4318`.

## Use your own stack

- Point the api and worker at your collector: `FLAKEMETRY_SELF_OTEL_ENDPOINT`, or
  `selfTelemetry.otlpEndpoint` in the Helm chart. Each replica reports as its own
  `service.instance.id` (the pod name on Kubernetes).
- Load `rules/flakemetry.rules.yml` into Prometheus, or into a `PrometheusRule` under the
  Prometheus Operator.
- Import the dashboard into Grafana.

The rules and dashboard use the names Prometheus gives OTLP metrics by default: dots become
underscores, counters end in `_total`, and millisecond histograms end in
`_milliseconds_bucket`. A test in `apps/api` fails if they name a metric the code does not
export, or if an ingestion route falls outside the SLO's route selector.

## What each metric measures

| Metric | Kind | Meaning |
| --- | --- | --- |
| `flakemetry.http.server.duration` | histogram, ms | Every api request, by `route` and `status`. The ingestion SLOs read it on `/v1/ingest*` and `/v1/traces` |
| `flakemetry.ingest.runs_accepted`, `…executions_accepted` | counter | Accepted for processing |
| `flakemetry.ingest.rate_limited`, `…backpressured` | counter | Refused with 429 or 503 before anything was queued |
| `flakemetry.queue.depth` | gauge | Jobs waiting, as the api sees it; alerts use this one because it keeps reporting when every worker is down |
| `flakemetry.worker.time_to_processed` | histogram, ms | From accepted to processed: the processing SLO |
| `flakemetry.worker.processing_lag`, `…processing_duration` | histogram, ms | The two halves of it: waiting for a worker, and the work itself |
| `flakemetry.worker.jobs_processed`, `…jobs_failed`, `…jobs_dead_lettered` | counter | Outcomes. `jobs_failed` carries `outcome`: `retry` or `dead` |
| `flakemetry.worker.rca_*`, `flakemetry.worker.plugin_*` | counter | Root-cause analysis and analyzer plugin activity |
