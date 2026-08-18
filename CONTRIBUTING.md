# Contributing to Flakemetry

## Development setup

```bash
git clone https://github.com/AKogut/flakemetry.git
cd flakemetry
pnpm install
docker compose up
```

Node 20+ and pnpm 9+ are required (the `packageManager` pin resolves the exact pnpm version through corepack).

## Workflow

Trunk-based development. Branch from `main`, keep branches short-lived and scoped to one issue:

```
<type>/<issue-number>-<short-kebab-summary>
```

Types: `feat`, `fix`, `chore`, `refactor`, `docs`, `ci`, `spike`. Commits follow [Conventional Commits](https://www.conventionalcommits.org/). See the [Branching & Git Workflow](https://github.com/AKogut/flakemetry/wiki/Branching-and-Git-Workflow) wiki page for the full rules.

## Running the tests

**`pnpm test` without a database passes while skipping more than half the suite.** Every test
that touches Postgres is guarded by `describe.skipIf(!hasDb)`, so a run with no `DATABASE_URL`
reports every task green:

```
Tasks: 28 successful      573 passed, 608 skipped
```

Scoring, tenant isolation, erasure, the queue — none of it ran. Point the tests at the
database `docker compose up` already started, and set `REQUIRE_DB=1` so a database that is
unreachable fails loudly instead of quietly skipping:

```bash
DATABASE_URL="postgresql://flakemetry:flakemetry@localhost:5432/flakemetry?schema=public" \
  REQUIRE_DB=1 pnpm test
```

```
Tasks: 28 successful      895 passed, 0 skipped
```

Each package migrates its own test schema on the way in, so there is nothing to set up first.

Two things worth knowing when a change looks fine and is not:

- `pnpm exec turbo run test --force` runs the packages **concurrently and without the cache**.
  Serial cached runs hide interference between suites; this is how a Prisma upgrade was caught
  writing to the wrong schema.
- Prefer proving a guard by breaking what it guards. A test that passes because it stopped
  looking passes exactly as convincingly as one that works.

## Before opening a pull request

```bash
pnpm build
pnpm lint
pnpm typecheck
pnpm format:check
DATABASE_URL="postgresql://flakemetry:flakemetry@localhost:5432/flakemetry?schema=public" REQUIRE_DB=1 pnpm test
```

CI runs the same tasks with turbo affected filtering; all checks must be green before merge.
`pnpm format:check` is a separate step and is the one most often forgotten — run `pnpm format`
before pushing.

## Changesets

Every PR that touches a published package must include a changeset. The published ones are:

`@flakemetry/contracts` · `core` · `sdk` · `cli` · `playwright-reporter` · `vitest-reporter` · `jest-reporter`

A test in `apps/api` checks this list against the workspace, so it cannot drift from what is
actually published.

```bash
pnpm changeset
```

Pick the affected packages, choose the semver bump, and describe the change from a consumer's perspective. Internal packages (`db`, apps, shared configs) do not need changesets.

Releases are automated: merged changesets accumulate into a version PR, and merging that PR publishes to npm with provenance.

## Code style

- No comments in source code — code should read clearly on its own
- Prettier and ESLint are enforced in CI (`pnpm format`, `pnpm lint`)
- Tests colocate with the package they cover
- Explain **why** in a comment where the reason is not obvious from the code; do not narrate
  what the code already says
