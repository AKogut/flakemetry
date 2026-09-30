# Reference plugins

Two working Flakemetry plugins. Copy either one as a starting point. The [plugins guide](https://akogut.github.io/flakemetry/guide/plugins) documents the contract.

| File | Hook | What it does |
| --- | --- | --- |
| `slow-outlier.mjs` | `analyze` | Flags a passing test that took at least three times its median over its recent passing runs, once it has five samples |
| `tap.mjs` | `parse` | Reads TAP 13, including the nested subtests `node --test --test-reporter=tap` prints, so a TAP report can be sent to `POST /v1/ingest/plugin/tap` |

Load them on the API and the worker:

```bash
FLAKEMETRY_PLUGINS=/plugins/slow-outlier.mjs,/plugins/tap.mjs
```

Both are covered by the test suite: `packages/plugin-host` loads them, `apps/worker` runs the analyzer against a real database, and `apps/api` ingests a TAP report through the parser.
