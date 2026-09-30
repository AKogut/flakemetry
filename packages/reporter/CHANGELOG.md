# @flakemetry/playwright-reporter

## 0.1.4

### Patch Changes

- 55b17be: Installs on Playwright 1.44 and later again. A dependency update had narrowed the peer range to `^1.62.1`, so npm refused the install on older Playwright releases, although the reporter works unchanged on them. It was checked on 1.44.1 and 1.63.0.
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

- Updated dependencies [3187041]
  - @flakemetry/sdk@0.2.0

## 0.1.0

### Minor Changes

- b2a2d3d: First public release of the Flakemetry packages: the OpenTelemetry SDK and Playwright reporter for shipping tests as traces, the shared zod contracts and identity/scoring core, and the `flakemetry` CLI.

### Patch Changes

- Updated dependencies [b2a2d3d]
  - @flakemetry/contracts@0.1.0
  - @flakemetry/sdk@0.1.0
