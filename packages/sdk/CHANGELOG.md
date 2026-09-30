# @flakemetry/sdk

## 0.2.3

### Patch Changes

- 49cb6b1: Dependency updates: OpenTelemetry 2.11 / 0.222 in the SDK, zod 4.6 in the contracts, and newer `yaml` and `fast-xml-parser` in the CLI.
- 2d07cc2: File paths are normalized by segment, so equivalent spellings of a path give one fingerprint. `/./tests/a.spec.ts`, `././tests/a.spec.ts`, `tests//a.spec.ts` and `tests/./a.spec.ts` used to give different fingerprints, which could split one test's history across identities when it was reported through more than one route. Paths without such segments normalize exactly as before, so existing fingerprints do not change.
- b23f674: Sharded Jest and Vitest runs keep every shard. Each shard of one CI run used to get the same idempotency key, so the API kept the first shard and dropped the rest as re-deliveries. The reporters now pass the runner's `--shard` to the SDK, and the SDK reads `FLAKEMETRY_SHARD_INDEX` / `FLAKEMETRY_SHARD_TOTAL`, which were documented but never read, for suites split some other way.
- 2682df5: TypeScript projects that load these packages with `require` now get CommonJS type declarations. Every package pointed both `import` and `require` at the ESM declaration file, so under `moduleResolution: node16` a CommonJS consumer got types describing an ES module ("masquerading as ESM"). The files that run are unchanged.
- Updated dependencies [63cd348]
- Updated dependencies [49cb6b1]
- Updated dependencies [2d07cc2]
- Updated dependencies [9cf5e92]
- Updated dependencies [674ddb3]
- Updated dependencies [cd50173]
- Updated dependencies [cd52503]
- Updated dependencies [2682df5]
- Updated dependencies [eae093b]
  - @flakemetry/contracts@0.3.0
  - @flakemetry/core@0.1.3

## 0.2.2

### Patch Changes

- Updated dependencies [09519db]
- Updated dependencies [a04f9f7]
  - @flakemetry/contracts@0.2.1
  - @flakemetry/core@0.1.2

## 0.2.1

### Patch Changes

- Updated dependencies [6c2680d]
  - @flakemetry/contracts@0.2.0
  - @flakemetry/core@0.1.1

## 0.2.0

### Minor Changes

- 3187041: Detect GitLab CI, CircleCI and Jenkins.

  Runs outside GitHub Actions were reported as `local`, at commit `0000000` on branch
  `local`. A whole project's history collapsing onto one commit is read by scoring as
  "same commit, different result" — the flakiness signal — so it manufactured flakiness for
  every test on those platforms, left the pull-request gate without a base branch to
  compare against, and fell back to a per-process idempotency key so parallel jobs never
  deduplicated.

  CircleCI numbers its parallel containers from zero and Flakemetry from one; the index is
  translated so a shard means the same thing whichever platform produced it.

## 0.1.0

### Minor Changes

- b2a2d3d: First public release of the Flakemetry packages: the OpenTelemetry SDK and Playwright reporter for shipping tests as traces, the shared zod contracts and identity/scoring core, and the `flakemetry` CLI.

### Patch Changes

- Updated dependencies [b2a2d3d]
  - @flakemetry/contracts@0.1.0
  - @flakemetry/core@0.1.0
