# @flakemetry/docs

The canonical Flakemetry documentation site, built with [VitePress](https://vitepress.dev)
and deployed to GitHub Pages by [`.github/workflows/docs.yml`](../../.github/workflows/docs.yml).

## Local development

```bash
pnpm --filter @flakemetry/docs dev       # regenerates the API reference, then serves
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

## Versions

The site at the root follows `main`. Each release also keeps a copy of the documentation as
it was when the release went out, under `/v/<YYYY-MM-DD>/`.

- When a version pull request is merged, [`release.yml`](../../.github/workflows/release.yml)
  calls [`docs-snapshot.yml`](../../.github/workflows/docs-snapshot.yml). It builds the site
  with `DOCS_VERSION` set, stores the result under `v/<date>/` on the `docs-snapshots` branch,
  and redeploys.
- [`docs.yml`](../../.github/workflows/docs.yml) builds `main` with `DOCS_SNAPSHOTS` listing
  what that branch holds, which fills the version menu and the `/versions` page, then copies
  the stored snapshots next to it.
- A copy is built once, by the toolchain of its day, and never rebuilt. A second release on
  the same day replaces that day's copy. To take one by hand, run **docs snapshot** from the
  Actions tab with a ref and, optionally, a date.

| Variable | Effect |
| --- | --- |
| `DOCS_VERSION` | Builds a release copy: base `/flakemetry/v/<date>/`, a banner that points to the latest, `noindex`, no edit links, no sitemap |
| `DOCS_SNAPSHOTS` | Dates of the stored copies, space or comma separated; the latest build lists them |
| `DOCS_SITE` | Absolute URL of the latest site, `https://akogut.github.io/flakemetry/` by default. Set it to preview the version links locally |
