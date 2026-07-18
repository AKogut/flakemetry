# @flakemetry/sdk

OpenTelemetry test instrumentation for [Flakemetry](https://github.com/AKogut/flakemetry). Records a test run, computes stable test identities, and exports the run as real OTLP spans.

Most users do not depend on this directly — the [`@flakemetry/playwright-reporter`](https://www.npmjs.com/package/@flakemetry/playwright-reporter) builds on it. Use this package to write a reporter for another test runner.

## Install

```bash
pnpm add -D @flakemetry/sdk
```

## Usage

```ts
import { exportRunOverOtlp, TestRunRecorder } from '@flakemetry/sdk'

const recorder = new TestRunRecorder({
  project: 'acme/web',
  commitSha: process.env.GITHUB_SHA!,
  branch: 'main',
  ciProvider: 'github_actions',
  trigger: 'push',
})

recorder.startRun(new Date())
recorder.record({
  filePath: 'e2e/login.spec.ts',
  suite: 'auth',
  title: 'logs in',
  status: 'fail',
  attempt: 1,
  startedAt: new Date(),
  durationMs: 1800,
  error: { message: 'Timeout 30000ms exceeded' },
})
recorder.finishRun('failed', new Date())

await exportRunOverOtlp(recorder, 'ci-run-42', {
  endpoint: process.env.FLAKEMETRY_ENDPOINT!,
  token: process.env.FLAKEMETRY_TOKEN!,
})
```

The whole run ships as one OTLP/HTTP request (`test.run` parent span with a `test.case` child per attempt) to `POST /v1/traces`.

## What it gives you

- **Span builders** following the [test semantic conventions](https://github.com/AKogut/flakemetry/blob/main/docs/otel-conventions.md) — `test.run` → `test.case`, retry linkage, exception events, artifact references.
- **Stable test identity** — `computeFingerprint` normalizes paths and hashes parameters so a test keeps its history across refactors.
- **Fail-open delivery** — `IngestClient` never throws into your test process; failed runs can buffer to disk and replay on the next run via `flushBuffered()`.
- **Sampling** — `shouldDeliverRun` keeps every run containing a failure or flake and samples the rest.

## License

MIT © Andrii Kohut
