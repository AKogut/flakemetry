# Public demo

The [public demo](https://akogut.github.io/flakemetry/demo/) runs Flakemetry on the real CI history
of three public test suites. Nothing is seeded, and those repositories need no secret and no
change to how they run, because this job reads what they already upload.

| Suite | Runners | What it reads |
| --- | --- | --- |
| [playwright-ecommerce-framework](https://github.com/AKogut/playwright-ecommerce-framework) | Playwright on three browsers | The batches its reporter writes |
| [restful-booker-api-testing](https://github.com/AKogut/restful-booker-api-testing) | Vitest, hosted and local targets | JUnit reports |
| [mobile-task-manager-automation](https://github.com/AKogut/mobile-task-manager-automation) | Appium, XCUITest, Espresso | Allure results, `xcresulttool` summaries, JUnit reports |

## How it is built

Every night [`demo.yml`](../../.github/workflows/demo.yml) does this on a clean machine:

1. `collect.mjs` adds any new artifacts to the `demo-history` branch, one gzipped batch per run. Artifacts expire and history must not, so that branch is the record.
2. `load.mjs` starts from an empty database and replays all of it through a real API and worker.
3. `snapshot.mjs` crawls the public read-only pages and writes a static site, then fails if a page has a broken link, a script, a form or anything shaped like a token.
4. The docs site publishes the result under `/demo/`.

Rebuilding from nothing every night means a scoring change reaches all of the history at once.

## Where older runs come from

Runs from before those suites kept their results were reconstructed once with `backfill.mjs`, from the CI logs of the time. Which test passed or failed on which night is real, and so are XCUITest and Appium retries. Durations and error text can be missing, and a green `restful-booker` night is taken as every test having passed, because its log only lists failures.

## Running it yourself

You need Postgres, and the API, worker and web app running.

```bash
export DATABASE_URL=postgresql://flakemetry:flakemetry@localhost:5432/flakemetry?schema=public
pnpm --filter @flakemetry/db exec prisma migrate deploy

git worktree add /tmp/demo-history origin/demo-history
pnpm --filter flakemetry-public-demo collect /tmp/demo-history
pnpm --filter flakemetry-public-demo load /tmp/demo-history /tmp/provisioned.json
pnpm --filter flakemetry-public-demo snapshot /tmp/provisioned.json /tmp/site
```
