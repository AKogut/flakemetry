# @flakemetry/docs

The canonical Flakemetry documentation site, built with [VitePress](https://vitepress.dev)
and deployed to GitHub Pages by [`.github/workflows/docs.yml`](../../.github/workflows/docs.yml).

## Local development

```bash
pnpm --filter @flakemetry/docs dev       # hot-reloading dev server
pnpm --filter @flakemetry/docs build     # static build to .vitepress/dist
pnpm --filter @flakemetry/docs preview    # serve the built site
```

## Structure

- `guide/` — getting started, self-hosting, reporters, JUnit, GitHub Action, CLI.
- `concepts/` — test identity, flaky scoring, AI RCA, OTel conventions, architecture.
- `reference/` — configuration, threat model, and the generated API reference.
- `.vitepress/config.ts` — navigation, sidebar, and site metadata.

`reference/api.md` is **generated** by `scripts/generate-api-reference.ts` from the zod
contracts and the declared API surface in `packages/contracts/src/rest.ts`; it is written on
every build and is not committed. An `api-surface` test in `apps/api` asserts that the declared
surface matches the routes the Fastify app actually registers and the procedures the tRPC
router actually exposes, so the reference cannot drift from the code.

The reference pages under `concepts/architecture`, `concepts/otel-conventions`,
`reference/configuration`, and `reference/threat-model` include the canonical documents in
[`docs/`](../../docs) so the site and the code-adjacent references never diverge.

## Deployment

GitHub Pages must be set to build from GitHub Actions (Settings → Pages → Source →
GitHub Actions). The site is then published to `https://akogut.github.io/flakemetry/` on
every push to `main` that touches `apps/docs/**` or `docs/**`.
