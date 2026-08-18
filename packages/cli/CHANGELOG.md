# @flakemetry/cli

## 0.2.0

### Minor Changes

- fc7f57f: Add `run`, `flaky` and `doctor`. `flakemetry run -- pnpm test` wraps a test command, uploads the results afterwards and exits with the command's own code — an upload problem warns but never turns a green build red. `flakemetry flaky` lists the flaky board from the terminal (`--json` for scripting, `--quarantined` to filter), and `flakemetry doctor` reports the configuration, connectivity and what the token is allowed to do, with the token redacted. Both query commands need a token with the `read` scope.
- 6c2680d: Add the `quarantine` token scope and `flakemetry quarantine`.

  `TOKEN_SCOPES` gains a third entry alongside `ingest` and `read`. It is separate because it is the one call that can stop a failing test from blocking a build, and that should be granted deliberately rather than arriving with the ability to read. Anything narrowing a `TokenScope` union will see the new member.

  `flakemetry quarantine <testId>` holds a test in or out of quarantine by hand, and `--auto` hands it back to the scorer. A decision made this way is not overwritten on the next run.

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
