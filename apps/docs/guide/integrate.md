# Integrating a project

This is the whole path, from nothing to a flaky board with your own tests on it. Each
project runs its own instance, so every step below happens once per project.

Budget about fifteen minutes, most of it waiting for images to build.

## 1. Create a GitHub OAuth app

The dashboard signs in with GitHub, so this comes first — the stack will start without
it, but nobody can log in.

Go to **GitHub → Settings → Developer settings → OAuth Apps → New OAuth App** and fill
in exactly these:

| Field | Value |
|---|---|
| Application name | anything — `Flakemetry (checkout-service)` |
| Homepage URL | `http://localhost:3000` |
| Authorization callback URL | `http://localhost:3000/api/auth/callback/github` |

The callback must match character for character, including the scheme and the absence
of a trailing slash. A mismatch fails at sign-in with `redirect_uri_mismatch`, which
reads as a Flakemetry problem and is not one.

Press **Generate a new client secret** and keep both values to hand. The secret is
shown once.

> Running the instance somewhere other than localhost? Use that host in both fields,
> and set `AUTH_URL` to it in the next step.

## 2. Bring up the stack

```bash
git clone https://github.com/AKogut/flakemetry.git
cd flakemetry
cp .env.example .env
echo "AUTH_SECRET=$(openssl rand -base64 32)" >> .env
```

Put the two values from step 1 into `.env`:

```bash
AUTH_GITHUB_ID=Iv1.xxxxxxxxxxxx
AUTH_GITHUB_SECRET=xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
```

Then:

```bash
docker compose up
```

The dashboard is on [localhost:3000](http://localhost:3000), the ingestion API on
[localhost:4000](http://localhost:4000). It opens on a demo dataset so there is
something to look at before your own tests arrive.

The demo data is only written when the database is empty — restarting the stack keeps
everything you have ingested since.

## 3. Sign in and take the workspace

Sign in with GitHub. The first account to do so adopts the seeded workspace, so
whoever sets the instance up becomes its owner.

## 4. Create your project and its token

The demo project is called *Acme Web*. Add your own from **Projects → Add project**,
then **Ingest tokens → New token** on the project it creates. The token is shown once.

Each project keeps its own history, policy and tokens, so a token from one project
cannot write into another.

## 5. Point your test suite at it

Install the reporter for your runner and add one line of config:

::: code-group

```ts [Playwright]
// playwright.config.ts
import { defineConfig } from '@playwright/test'

export default defineConfig({
  reporter: [['@flakemetry/playwright-reporter']],
})
```

```ts [Vitest]
// vitest.config.ts
import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: { reporters: ['default', '@flakemetry/vitest-reporter'] },
})
```

```js [Jest]
// jest.config.js
export default {
  reporters: ['default', '@flakemetry/jest-reporter'],
}
```

:::

```bash
npm i -D @flakemetry/playwright-reporter   # or vitest-reporter / jest-reporter
```

Then run the suite with the endpoint and token in the environment:

```bash
FLAKEMETRY_ENDPOINT=http://localhost:4000 \
FLAKEMETRY_TOKEN=fmk_... \
npx playwright test
```

No native reporter for your runner? Anything that writes **JUnit XML** works through
the CLI — see [Any runner via JUnit XML](/guide/junit).

Delivery never fails the run. If the endpoint is unreachable the suite still reports
its own result, and nothing is lost from your build.

## 6. Give it a history

Flaky scoring needs samples — a handful of runs before it will say anything useful.
Rather than waiting a fortnight, replay the JUnit reports your CI has already
produced:

```bash
FLAKEMETRY_ENDPOINT=http://localhost:4000 FLAKEMETRY_TOKEN=fmk_... \
  npx flakemetry import ./ci-artifacts
```

Every report becomes a run, dated from the report rather than from the moment of
import, so the board is useful the same day. See [CLI](/guide/cli) for what it does
with commits and re-runs.

## 7. Wire it into CI

The upload step runs even when tests fail and never blocks the build — see
[GitHub Action](/guide/github-action), or set `FLAKEMETRY_ENDPOINT` and
`FLAKEMETRY_TOKEN` as secrets on any other provider. GitLab CI, CircleCI and Jenkins
are detected automatically, so commits, branches, pull requests and parallel shards
are recorded without further configuration.

## When something is wrong

| Symptom | Cause |
|---|---|
| `redirect_uri_mismatch` at sign-in | The callback URL in the OAuth app does not match step 1 exactly |
| Sign-in loops back to the sign-in page | `AUTH_SECRET` is missing from `.env` |
| Runs never appear | Token belongs to a different project, or `FLAKEMETRY_ENDPOINT` is unset — the reporter stays silent by design rather than failing your suite |
| Dashboard is empty after a restart | Someone ran `pnpm demo`, which resets to the demo dataset on purpose |
| Board shows no scores yet | Fewer runs than the policy's minimum sample size; import history (step 6) or lower it in **Policy** |
