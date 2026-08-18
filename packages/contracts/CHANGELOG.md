# @flakemetry/contracts

## 0.3.0

### Minor Changes

- cd50173: The daily LLM token budget is now a per-project policy field. It was read only from the environment, so `ai.dailyTokenBudget` in a project's `flakemetry.yml` was documented, validated and ignored — one instance could have exactly one budget.
- eae093b: Move to zod 4. The validation shape on the wire is unchanged — `{ error, issues: [{ path, message }] }` — but the messages are more specific: an invalid commit sha now reports the pattern it had to match instead of a bare "Invalid".

  `zod-to-json-schema` is gone; zod 4 generates JSON Schema itself, which the OpenAPI document and the API reference now use.

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
