# @flakemetry/vitest-reporter

## 0.1.4

### Patch Changes

- b23f674: Sharded Jest and Vitest runs keep every shard. Each shard of one CI run used to get the same idempotency key, so the API kept the first shard and dropped the rest as re-deliveries. The reporters now pass the runner's `--shard` to the SDK, and the SDK reads `FLAKEMETRY_SHARD_INDEX` / `FLAKEMETRY_SHARD_TOTAL`, which were documented but never read, for suites split some other way.
- 2682df5: TypeScript projects that load these packages with `require` now get CommonJS type declarations. Every package pointed both `import` and `require` at the ESM declaration file, so under `moduleResolution: node16` a CommonJS consumer got types describing an ES module ("masquerading as ESM"). The files that run are unchanged.
- df69361: Installs and reports correctly on every Vitest from 1.6 to 5.

  - The peer range was `^4.1.10`, so npm refused the install with `ERESOLVE` on Vitest 5, and on 1.6–3, which the reporter supported before a dependency sweep narrowed the range. It is now `^1.6.0 || ^2.0.0 || ^3.0.0 || ^4.0.0 || ^5.0.0`.
  - On Vitest 3, which calls both `onFinished` and `onTestRunEnd`, each run was delivered twice. Outside CI the two deliveries had different idempotency keys, so two runs were stored. A run is now delivered once, and each run of a watch session is still delivered.

- Updated dependencies [63cd348]
- Updated dependencies [49cb6b1]
- Updated dependencies [2d07cc2]
- Updated dependencies [9cf5e92]
- Updated dependencies [674ddb3]
- Updated dependencies [cd50173]
- Updated dependencies [b23f674]
- Updated dependencies [cd52503]
- Updated dependencies [2682df5]
- Updated dependencies [eae093b]
  - @flakemetry/contracts@0.3.0
  - @flakemetry/sdk@0.2.3

## 0.1.3

### Patch Changes

- Updated dependencies [09519db]
- Updated dependencies [a04f9f7]
  - @flakemetry/contracts@0.2.1
  - @flakemetry/sdk@0.2.2

## 0.1.2

### Patch Changes

- Updated dependencies [6c2680d]
  - @flakemetry/contracts@0.2.0
  - @flakemetry/sdk@0.2.1

## 0.1.1

### Patch Changes

- 3187041: Report through `onTestRunEnd` as well as `onFinished`.

  Vitest 4 removed `onFinished`, so the reporter was never called on it: the suite passed,
  the reporter stayed silent as it is designed to, and no data reached the server. 0.1.0
  already declares `vitest: ^4` as a peer, so it makes a promise it cannot keep on the
  version it names.

  Both hooks now share one path, so a single build serves Vitest 3 and 4.

- Updated dependencies [3187041]
  - @flakemetry/sdk@0.2.0
