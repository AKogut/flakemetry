## What

<!-- One or two sentences: what does this PR do? -->

## Why

Closes #

## How it was verified

<!-- Commands you ran and what they showed. For a bug fix, say how you saw the test fail without the fix. -->

## Checklist

- [ ] Branch follows `<type>/<issue>-<slug>` and the commit follows Conventional Commits
- [ ] `pnpm build && pnpm lint && pnpm typecheck && pnpm format:check` pass
- [ ] Tests pass against a database (`DATABASE_URL=… REQUIRE_DB=1 pnpm test`, `0 skipped`)
- [ ] Changeset added if a published package changed (`pnpm changeset`)
- [ ] Docs or an ADR updated if behaviour or a load-bearing decision changed
