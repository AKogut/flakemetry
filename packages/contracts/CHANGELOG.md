# @flakemetry/contracts

## 0.2.0

### Minor Changes

- 6c2680d: Add the `quarantine` token scope and `flakemetry quarantine`.

  `TOKEN_SCOPES` gains a third entry alongside `ingest` and `read`. It is separate because it is the one call that can stop a failing test from blocking a build, and that should be granted deliberately rather than arriving with the ability to read. Anything narrowing a `TokenScope` union will see the new member.

  `flakemetry quarantine <testId>` holds a test in or out of quarantine by hand, and `--auto` hands it back to the scorer. A decision made this way is not overwritten on the next run.

## 0.1.0

### Minor Changes

- b2a2d3d: First public release of the Flakemetry packages: the OpenTelemetry SDK and Playwright reporter for shipping tests as traces, the shared zod contracts and identity/scoring core, and the `flakemetry` CLI.
