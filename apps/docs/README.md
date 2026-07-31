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
- `reference/` — configuration and threat model.
- `.vitepress/config.ts` — navigation, sidebar, and site metadata.

The reference pages under `concepts/architecture`, `concepts/otel-conventions`,
`reference/configuration`, and `reference/threat-model` include the canonical documents in
[`docs/`](../../docs) so the site and the code-adjacent references never diverge.

## Deployment

GitHub Pages must be set to build from GitHub Actions (Settings → Pages → Source →
GitHub Actions). The site is then published to `https://akogut.github.io/flakemetry/` on
every push to `main` that touches `apps/docs/**` or `docs/**`.
