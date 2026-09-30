# Development guide

This page gets you from a fresh clone to a pull request: how to set the repository up, where
things live, how the tests work, and the handful of changes that touch more than one package.
The rules for branches, commits and changesets are in
[CONTRIBUTING.md](https://github.com/AKogut/flakemetry/blob/main/CONTRIBUTING.md).

## Setting up

You need Node 22.18 or later (the build toolchain requires it; the published packages still run on Node 20), pnpm (the version pinned in `packageManager`; `corepack enable`
provides it), and Docker.

```bash
git clone https://github.com/AKogut/flakemetry.git
cd flakemetry
pnpm install
pnpm build
docker compose up -d postgres
```

That is enough for every package's tests. To run the whole product (API, worker, dashboard,
object store) the way a user does:

```bash
cp .env.example .env
echo "AUTH_SECRET=$(openssl rand -base64 32)" >> .env
pnpm stack:up
pnpm demo
```

The dashboard signs in through GitHub only. The [self-hosting guide](/guide/self-hosting)
explains the OAuth app it needs.

## Where things live

Dependencies point one way: apps depend on packages, packages depend on `contracts`, and
nothing depends on an app. The published packages are the ones a user installs. Everything
else ships inside the Docker images.

| Workspace | What it is | Published |
| --- | --- | --- |
| `apps/api` | Fastify service: ingestion (`/v1/ingest`, OTLP `/v1/traces`), the REST read API, badges, tRPC | no |
| `apps/worker` | Queue consumer: identity, scoring, rollups, clustering, AI analysis, notifications, retention | no |
| `apps/web` | Next.js dashboard | no |
| `apps/docs` | This documentation site (VitePress) | no |
| `packages/contracts` | zod schemas shared by everything: ingestion payloads, config, policy, REST surface | yes |
| `packages/core` | Pure domain logic: test identity, fingerprints, flaky scoring. No I/O | yes |
| `packages/sdk` | Recording, OTLP export, delivery, CI detection | yes |
| `packages/reporter` | `@flakemetry/playwright-reporter` | yes |
| `packages/vitest-reporter` | `@flakemetry/vitest-reporter` | yes |
| `packages/jest-reporter` | `@flakemetry/jest-reporter` | yes |
| `packages/cli` | `flakemetry` command: upload, run, junit, import, flaky, quarantine, doctor | yes |
| `packages/pytest-flakemetry` | pytest plugin (Python, released separately to PyPI) | no |
| `packages/db` | Prisma schema, migrations, seed, client | no |
| `packages/queries` | Tenant-scoped reads and writes shared by the API and the dashboard | no |
| `packages/ai` | LLM providers, scrubbing, root-cause prompts | no |
| `packages/notify` | Slack, Discord, email and signed webhook delivery, tracker issues | no |
| `packages/storage` | Object store for artifacts (S3, MinIO, in-memory) | no |
| `packages/eslint-config` | Shared lint rules | no |
| `packages/tsconfig` | Shared TypeScript presets | no |
| `packages/build-config` | Shared tsdown build presets; published packages are checked with publint and arethetypeswrong | no |

A test run travels like this:

1. A reporter records the run with the SDK and sends it: OTLP to `/v1/traces`, or JSON to
   `/v1/ingest`. The SDK never fails the test run over a delivery problem.
2. `apps/api/src/app.ts` authenticates the token, validates against `contracts`, enqueues
   the batch in Postgres and answers `202`.
3. `apps/worker/src/processor.ts` takes the batch (`FOR UPDATE SKIP LOCKED`), resolves each
   test's identity, stores executions, scores, updates rollups, and hands failures to
   `rca.ts`.
4. The dashboard and the REST API read through `packages/queries`, which scopes every query to
   one project.

## Everyday commands

```bash
pnpm build                                  # everything, through turbo
pnpm --filter @flakemetry/core test         # one package
pnpm lint && pnpm typecheck
pnpm format                                 # prettier is a separate CI step from eslint
pnpm exec turbo run test --force            # all packages at once, no cache
```

Workspace packages are consumed through their built `dist`. After changing `contracts` or
`core`, build it before type-checking whatever imports it.

## Tests

**Point the tests at a database.** Tests that need Postgres skip themselves when
`DATABASE_URL` is unset, so a run without it is green while testing about half of the code.
`REQUIRE_DB=1` turns an unreachable database into a failure instead:

```bash
DATABASE_URL="postgresql://flakemetry:flakemetry@localhost:5432/flakemetry?schema=public" \
  REQUIRE_DB=1 pnpm exec turbo run test --force
```

Each package migrates its own schema (`flakemetry_test_<package>`), so packages can run in
parallel without seeing each other's rows. Running them concurrently and uncached is
deliberate: that is how interference between suites shows up.

**Conventions the suite relies on:**

- Tests sit next to the code in `src/__tests__`.
- `packages/core` uses property tests (`fast-check`) for identity and scoring. A property
  that fails once in CI has found an input the code gets wrong; treat it as a bug, not as
  noise.
- Several tests guard a promise rather than a function: every `FLAKEMETRY_` variable the code
  reads is documented, every project query is tenant-scoped, every REST route is in the
  generated reference and the OpenAPI document, web and worker receive the same policy
  variables, the Policy form has an input for every field it saves, and reporter peer ranges
  do not narrow. When one fails, fix the drift it found. Do not loosen the test.
- A new test should fail without the change it covers. Revert the fix, watch it fail, put
  the fix back.

**Checks that run the real thing** live in `.github/workflows`: `stack` runs the README
quickstart, `reporters` runs every reporter inside its real runner against a live API and
worker, `backup` destroys and restores the database, and `e2e` runs nightly.

## Changes that cross packages

**A new policy field.** Add it to `POLICY_DEFAULTS`, `POLICY_FIELDS` and
`projectPolicyInputSchema` in `packages/contracts/src/policy.ts`, including its environment
variable. Add the column in `packages/db`, the input on the Policy page
(`apps/web/src/app/projects/[projectId]/settings/policy/page.tsx`) and in
`updateProjectPolicy`, and pass the variable to both web and worker in both compose files.
Guard tests fail until every one of those is done.

**A database change.** Edit `packages/db/prisma/schema.prisma`, then
`pnpm --filter @flakemetry/db exec prisma migrate dev --name <what>`. Migrations must be
additive: the self-hosted upgrade path is "rebuild and restart", with no manual step.

**A REST route.** Describe it in `REST_ENDPOINTS` (`packages/contracts/src/rest.ts`) and
register it in `apps/api`. The API reference and `/openapi.json` are generated from that
table, and a test fails if the table and the registered routes disagree.

**A notification event.** Add it to `NOTIFICATION_EVENTS` in `packages/contracts` and
`NOTIFICATION_TYPES` in `packages/notify` (a test keeps them equal), emit it from the worker,
and give it a label on the notifications settings page.

**A published package.** Add a changeset (`pnpm changeset`) describing the change from the
point of view of someone who installs it.

## Asking for help

Questions and half-formed ideas go to
[Discussions](https://github.com/AKogut/flakemetry/discussions). If an issue labelled
[`good first issue`](https://github.com/AKogut/flakemetry/labels/good%20first%20issue) needs
more context than it has, ask on the issue before starting.
