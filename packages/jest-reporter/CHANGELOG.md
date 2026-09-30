# @flakemetry/jest-reporter

## 0.1.5

### Patch Changes

- b23f674: Sharded Jest and Vitest runs keep every shard. Each shard of one CI run used to get the same idempotency key, so the API kept the first shard and dropped the rest as re-deliveries. The reporters now pass the runner's `--shard` to the SDK, and the SDK reads `FLAKEMETRY_SHARD_INDEX` / `FLAKEMETRY_SHARD_TOTAL`, which were documented but never read, for suites split some other way.
- 2682df5: TypeScript projects that load these packages with `require` now get CommonJS type declarations. Every package pointed both `import` and `require` at the ESM declaration file, so under `moduleResolution: node16` a CommonJS consumer got types describing an ES module ("masquerading as ESM"). The files that run are unchanged.
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

## 0.1.4

### Patch Changes

- Updated dependencies [09519db]
- Updated dependencies [a04f9f7]
  - @flakemetry/contracts@0.2.1
  - @flakemetry/sdk@0.2.2

## 0.1.3

### Patch Changes

- Updated dependencies [6c2680d]
  - @flakemetry/contracts@0.2.0
  - @flakemetry/sdk@0.2.1

## 0.1.2

### Patch Changes

- a755500: Keep the expected and received values from a Jest failure instead of only its first line. Jest renders one string rather than a structured error, and that first line is the matcher header — identical for every `toBe` in a project — so every assertion failure arrived with the same message, collapsing unrelated tests onto one error signature and giving root-cause analysis nothing to work with. ANSI colour codes are stripped from both the message and the stack.

## 0.1.1

### Patch Changes

- Updated dependencies [3187041]
  - @flakemetry/sdk@0.2.0
