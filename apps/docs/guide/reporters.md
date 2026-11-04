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

## Variants

The same test on two browsers is two sets of evidence. A test that always fails on WebKit is not
flaky because it passes on Chromium, so each variant keeps its own identity, score and history.

- **Playwright** records the project as the variant whenever the config has more than one. A
  single-project config records none, so its identities and history stay as they are.
- **Anything else** sets it for the run:

```bash
FLAKEMETRY_VARIANT=ios npx wdio run wdio.ios.conf.ts
FLAKEMETRY_VARIANT=live npx vitest run
FLAKEMETRY_VARIANT=api-35 npx flakemetry junit results.xml
npx flakemetry import ./archive --variant api-35
```

The variant is a parameter called `variant`, so it appears in the variants table on the test page,
and the board and the PR comment show it next to the title.

Adding a variant to a test that had none starts a new identity, because the evidence really is
different. The old history stays on the old identity.

### Comparing one test case across variants

When several runners work through one catalogue of test cases, each names the test its own way.
Put the id in the title and Flakemetry reads `TC-AUTH-001 — Successful login`,
`test_TC_AUTH_001_validLogin` and `TC_AUTH_001_successfulLogin` as one test case: `TC`, letters
and digits, separated by `-` or `_`.

As soon as one id appears on two variants, the project gets a **Test cases** page. It has one row
per test case, the most trouble first, and one column per variant, showing how many runs passed,
failed and passed on retry, with a link to the test. A retried test counts once per run, and
failures from runs where most of the suite failed together are left out, as they are in the score.

The page reads the project's latest runs, up to 500 and up to 50,000 test executions, whichever
comes first, so a large suite covers fewer runs. It says how many runs it covers and when older
runs are not included.

## Sharded suites

A suite split across parallel jobs sends one run per shard, and the key says which shard it
is. A matrix that runs the same suite several ways, such as one job per browser, needs nothing
extra: the reporters add a digest of the results to the key, so no two jobs share one.

Delivering the same results twice stores them once. The server compares content as well as the
key, so a batch with different results is kept even when its key repeats, which also protects
reporters published before this behaviour.

The reporters work out the shard on their own:

| Runner | Where the shard comes from |
| --- | --- |
| Playwright | `--shard=2/4` or `shard` in the config |
| Vitest | `--shard=2/4` |
| Jest | `--shard=2/4` |
| GitLab CI, CircleCI | the platform's parallel job variables, for any runner |

When a suite is split some other way, for example a hand-built matrix that passes each job
its own file list, set `FLAKEMETRY_SHARD_INDEX` and `FLAKEMETRY_SHARD_TOTAL` (1-based) in
each job. The runner's own shard wins over these, and they win over CI detection.

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
