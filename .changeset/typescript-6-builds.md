---
'@flakemetry/contracts': patch
'@flakemetry/core': patch
'@flakemetry/sdk': patch
'@flakemetry/cli': patch
'@flakemetry/playwright-reporter': patch
'@flakemetry/vitest-reporter': patch
'@flakemetry/jest-reporter': patch
---

TypeScript projects that load these packages with `require` now get CommonJS type declarations. Every package pointed both `import` and `require` at the ESM declaration file, so under `moduleResolution: node16` a CommonJS consumer got types describing an ES module ("masquerading as ESM"). The files that run are unchanged.
