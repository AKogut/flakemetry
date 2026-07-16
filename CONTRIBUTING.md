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

## Before opening a pull request

```bash
pnpm build
pnpm lint
pnpm typecheck
pnpm test
pnpm format:check
```

CI runs the same tasks with turbo affected filtering; all checks must be green before merge.

## Changesets

Every PR that touches a published package (`@flakemetry/contracts`, `core`, `sdk`, `playwright-reporter`, `ai`, `cli`) must include a changeset:

```bash
pnpm changeset
```

Pick the affected packages, choose the semver bump, and describe the change from a consumer's perspective. Internal packages (`db`, apps, shared configs) do not need changesets.

Releases are automated: merged changesets accumulate into a version PR, and merging that PR publishes to npm with provenance.

## Code style

- No comments in source code — code should read clearly on its own
- Prettier and ESLint are enforced in CI (`pnpm format`, `pnpm lint`)
- Tests colocate with the package they cover
