# OpenTelemetry Test Conventions

The canonical span and attribute model every reporter emits to. The machine-readable source of truth is [`packages/contracts/src/otel.ts`](../packages/contracts/src/otel.ts) (re-exported from `@flakemetry/sdk`); this document is the human-readable spec. Product rationale lives in [ADR-0002](adr/0002-otel-native-ingestion.md) and the [wiki](https://github.com/AKogut/flakemetry/wiki/OTel-Test-Conventions).

Conventions version: `0.1.0`.

## Span hierarchy

```
test.run                 root span — one CI job / suite invocation
 └─ test.case            one execution of one test (retries are separate cases)
     └─ test.step        a step / hook (added in M2)
```

M1 emits `test.run` + `test.case`. `test.step` and network/browser child spans arrive in M2.

## Resource / run attributes

| Key | Example | Meaning |
|---|---|---|
| `service.name` | `flakemetry-reporter` | standard OTel service identity |
| `flakemetry.project` | `acme/web` | project the results belong to |
| `ci.provider` | `github_actions` | CI provider |
| `ci.run_id` | `9000001` | provider run id |
| `vcs.commit_sha` | `a1b2c3d` | commit under test — enables the same-sha flake signal |
| `vcs.branch` | `main` | branch |
| `vcs.pr_number` | `42` | pull request, when applicable |
| `flakemetry.trigger` | `push` | run trigger (`push`/`pull_request`/`schedule`/`manual`/`other`) |
| `flakemetry.idempotency_key` | `gh-9000001-1` | one per run; makes re-delivery safe (falls back to the run span trace id) |
| `flakemetry.contract_version` | `0.1.0` | conventions/contract version stamp |

## Case span attributes

| Key | Example | Meaning |
|---|---|---|
| `test.identity.fingerprint` | `sha256:…` | stable identity (L1), computed by the reporter |
| `test.suite` | `auth` | grouping |
| `test.title` | `logs in` | display name |
| `test.file_path` | `e2e/auth/login.spec.ts` | source location |
| `test.params_hash` | `9f2c…` | parameterized bucket, omitted when absent |
| `test.status` | `pass \| fail \| skip \| flaky` | verdict |
| `test.attempt` | `2` | retry index (1-based) |
| `test.duration_ms` | `1834` | wall-clock duration |

## Status mapping

| Test status | OTel span status |
|---|---|
| `pass`, `flaky` | `OK` |
| `fail` | `ERROR` (+ exception event carrying type / message / stack) |
| `skip` | `UNSET` |

## Fingerprint (L1)

`sha256(normalized_file_path + ' ' + suite + ' ' + title + ' ' + params_hash)` where the path is workspace-relative, POSIX-separated and lowercased. This is the exact-match layer; the server-side identity engine resolves moves and renames on top of it (#18).

## OTLP → contracts mapping

Reporters export real OTLP spans via `@opentelemetry/exporter-trace-otlp-http` to `POST /v1/traces` (OTLP/HTTP JSON). The API normalizes the span tree into a contract-valid `ingestRunBatch` (`@flakemetry/contracts`) with `otlpToIngestBatch` before enqueueing, so downstream stages stay transport-agnostic. Field mapping:

| Batch field | Source |
|---|---|
| `resource.*` | run/resource attributes above (read from the OTLP Resource, falling back to `test.run` span attributes) |
| `executions[].{filePath,suite,title,status,attempt,durationMs}` | case span attributes |
| `executions[].retryOfIndex` | reconstructed from attempt ordering per fingerprint |
| `executions[].error` | the case span `exception` event (`exception.type` / `exception.message` / `exception.stacktrace`) |
| `run.status` | `test.run` span status (`ERROR` → `failed`), or any failing case |
| `idempotencyKey` | `flakemetry.idempotency_key`, else the run span trace id |
