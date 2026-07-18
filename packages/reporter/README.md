# @flakemetry/playwright-reporter

Playwright reporter for [Flakemetry](https://github.com/AKogut/flakemetry). Emits every test execution as an OpenTelemetry span so your test history becomes telemetry rather than a static report.

## Install

```bash
pnpm add -D @flakemetry/playwright-reporter
```

## Usage

```ts
import { defineConfig } from '@playwright/test'

export default defineConfig({
  reporter: [['@flakemetry/playwright-reporter']],
})
```

Set the endpoint and token in CI:

```bash
FLAKEMETRY_ENDPOINT=https://ingest.example.com
FLAKEMETRY_TOKEN=fmk_...
```

That is the whole setup. The reporter derives commit, branch, PR number and CI run id from the environment (GitHub Actions out of the box) and exports the run over OTLP when the suite finishes.

## What it captures

- Every attempt as its own execution, with retries linked to their first attempt
- Failure messages and stack traces as span exception events
- Artifact references (screenshot / video / trace) as workspace-relative paths
- A stable identity per test that survives file moves and renames

## Configuration

| Variable | Effect |
|---|---|
| `FLAKEMETRY_ENDPOINT` | Ingestion endpoint (required to upload) |
| `FLAKEMETRY_TOKEN` | Project ingest token (required to upload) |
| `FLAKEMETRY_TRANSPORT` | `otlp` (default) or `json` |
| `FLAKEMETRY_COMPRESSION` | `gzip` to compress the OTLP export |
| `FLAKEMETRY_BUFFER_DIR` | Buffer runs here when delivery fails; replayed on the next run |
| `FLAKEMETRY_SAMPLE_RATE` | Fraction (0–1) of *passing* runs to upload; runs with a failure or flake always upload |
| `FLAKEMETRY_OUTPUT_FILE` | Also write the batch to a file (useful for debugging) |

All of these can be passed as reporter options instead:

```ts
reporter: [['@flakemetry/playwright-reporter', { sampleRate: 0.25 }]]
```

Upload is fail-open: if the endpoint is unreachable, your test run still succeeds.

## License

MIT © Andrii Kohut
