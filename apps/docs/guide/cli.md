# CLI

`@flakemetry/cli` sends results and inspects configuration from any CI provider or a local
shell. Run it with `npx flakemetry <command>` or install it as a dev dependency.

All commands read `FLAKEMETRY_ENDPOINT` and `FLAKEMETRY_TOKEN` from the environment;
`--endpoint` and `--token` override them.

## `flakemetry upload [file]`

Uploads a reporter output file (default `flakemetry-results.json`) — the JSON a native
reporter writes when `FLAKEMETRY_OUTPUT_FILE` is set. Use this to split the test step from
the delivery step in CI.

```bash
FLAKEMETRY_OUTPUT_FILE=flakemetry-results.json npx playwright test
flakemetry upload flakemetry-results.json
```

The upload is skipped (not failed) when no endpoint or token is set, so it is safe to leave
in a pipeline that sometimes runs without credentials.

## `flakemetry junit [file]`

Parses a JUnit XML report (default `junit.xml`) and uploads it — the path for any runner
without a native reporter. See [Any runner via JUnit XML](/guide/junit).

```bash
pytest --junitxml=junit.xml
flakemetry junit junit.xml
```

Pass `--fail-on-error` to make the step exit non-zero on a delivery failure; by default it
never breaks the build.

## `flakemetry import <directory>`

Seeds history from an archive of JUnit XML reports, so the flaky board is useful on the
first day instead of after a fortnight of new runs.

```bash
flakemetry import ./ci-artifacts --dry-run   # see what would be sent
flakemetry import ./ci-artifacts
```

Every `.xml` file under the directory becomes one run:

- **Ordered oldest first.** Scoring is incremental and stamps first-seen dates as it goes,
  so a newest-first import would date every test to the end of its own history.
- **Each report gets its own commit**, derived from the report's bytes. Scoring reads
  "same commit, different result" as a flakiness signal, and one shared sha across months
  of history would manufacture that signal for every test in the archive.
- **Re-running is safe.** Idempotency keys are derived from each file's path and contents,
  so an interrupted import resumes and a repeated one changes nothing.
- **Timestamps** come from the report's `timestamp` attribute, then the manifest, then the
  file's modification time.

Reports carry no commit or branch of their own. When you know them, pass a manifest:

```json
{ "ci-artifacts/2026-05-01.xml": { "commitSha": "9fceb02", "branch": "main" } }
```

```bash
flakemetry import ./ci-artifacts --manifest history.json
```

Anything unparseable or empty is named on stderr rather than dropped quietly.

## `flakemetry config`

Prints the resolved configuration and where each value came from — the config file (if
any), environment, and whether a token is present (redacted). Add `--json` for machine
output.

```bash
flakemetry config
flakemetry config --json
```
