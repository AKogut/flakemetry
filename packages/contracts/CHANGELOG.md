# @flakemetry/contracts

## 0.2.1

### Patch Changes

- 09519db: `/openapi.json` now describes the whole API rather than the read half. It was generated from the read-route table, so ingestion, the quality gate, artifact presigning and quarantine were invisible to anything generating a client — with nothing in the document to say a client was seeing a fraction of it. Request bodies are now included, generated from the same zod schemas the endpoints validate against.
- a04f9f7: Stop a broken `flakemetry.yml` from failing a build, and make the tracker's environment settings work.

  `flakemetry run` resolved the config before spawning the wrapped command, so an invalid config file raised and the test suite never ran — the wrapper exists precisely so that Flakemetry cannot fail a build. It now warns and carries on. Config errors also arrive as a diagnosis rather than a Node stack trace.

  `FLAKEMETRY_TRACKER_ENABLED`, `FLAKEMETRY_TRACKER_AFTER_DAYS` and `FLAKEMETRY_TRACKER_RECOVERY_DAYS` were documented, passed through both compose files, and read by nothing. They now reach the policy layer like every other setting.

## 0.2.0

### Minor Changes

- 6c2680d: Add the `quarantine` token scope and `flakemetry quarantine`.

  `TOKEN_SCOPES` gains a third entry alongside `ingest` and `read`. It is separate because it is the one call that can stop a failing test from blocking a build, and that should be granted deliberately rather than arriving with the ability to read. Anything narrowing a `TokenScope` union will see the new member.

  `flakemetry quarantine <testId>` holds a test in or out of quarantine by hand, and `--auto` hands it back to the scorer. A decision made this way is not overwritten on the next run.

## 0.1.0

### Minor Changes

- b2a2d3d: First public release of the Flakemetry packages: the OpenTelemetry SDK and Playwright reporter for shipping tests as traces, the shared zod contracts and identity/scoring core, and the `flakemetry` CLI.
