# @flakemetry/cli

## 0.2.0

### Minor Changes

- fc7f57f: Add `run`, `flaky` and `doctor`. `flakemetry run -- pnpm test` wraps a test command, uploads the results afterwards and exits with the command's own code — an upload problem warns but never turns a green build red. `flakemetry flaky` lists the flaky board from the terminal (`--json` for scripting, `--quarantined` to filter), and `flakemetry doctor` reports the configuration, connectivity and what the token is allowed to do, with the token redacted. Both query commands need a token with the `read` scope.

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
