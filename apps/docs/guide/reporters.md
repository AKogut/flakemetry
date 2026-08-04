# Reporters

Flakemetry ships native reporters for **Playwright**, **Vitest**, **Jest**, and **pytest**. They share
one OpenTelemetry model, so runs from any of them land with the same test identity and
flaky scoring. No native reporter for your runner?
[Upload JUnit XML instead](/guide/junit).

Every reporter reads two environment variables and never fails your test run if delivery
hiccups:

- `FLAKEMETRY_ENDPOINT` — your ingestion API base URL.
- `FLAKEMETRY_TOKEN` — the per-project bearer token from the dashboard.

You can also point a reporter at a file with `FLAKEMETRY_OUTPUT_FILE` and upload later —
handy for splitting the test step from the upload step in CI (see the
[GitHub Action](/guide/github-action)).

## Playwright

```ts
import { defineConfig } from '@playwright/test'

export default defineConfig({
  reporter: [['@flakemetry/playwright-reporter']],
})
```

## Vitest

```ts
import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    reporters: ['default', '@flakemetry/vitest-reporter'],
  },
})
```

## Jest

```js
export default {
  reporters: ['default', '@flakemetry/jest-reporter'],
}
```

## pytest

::: warning Not on PyPI yet
`pytest-flakemetry` is not published, so `pip install pytest-flakemetry` will not resolve.
Install it from the repository until it is:

```bash
pip install "git+https://github.com/AKogut/flakemetry@main#subdirectory=packages/pytest-flakemetry"
```

Everything below works the same either way. If you would rather not install from git, a
pytest suite can also report through [JUnit XML](/guide/junit).
:::

```bash
pip install pytest-flakemetry
```

The plugin registers itself — there is nothing to add to `conftest.py`. Retries are recognised
when [`pytest-rerunfailures`](https://pypi.org/project/pytest-rerunfailures/) is installed, so a
test that passes on rerun is reported as flaky:

```bash
pytest --reruns 2
```

Parameterized cases keep their values as structured params, so the server buckets the variants
under one base test instead of treating each id as a separate test.

## What a reporter sends

Each reporter maps its framework's results onto the shared OTel test conventions —
file path, suite, title, parameters, status, attempts, duration, and error details — and
hands them to the SDK for delivery. Identity and fingerprint are computed **server-side**
from `filePath + suite + title + params`, so the same test keeps one identity no matter
which framework produced it. See [OTel test conventions](/concepts/otel-conventions) for
the span and attribute model.

Beyond the run itself, a reporter also syncs project context best-effort on each upload:
CODEOWNERS for [code ownership](/concepts/architecture), notification routing from
`flakemetry.yml`, and test artifacts (screenshots, video, traces).
