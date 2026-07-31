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

## `flakemetry config`

Prints the resolved configuration and where each value came from — the config file (if
any), environment, and whether a token is present (redacted). Add `--json` for machine
output.

```bash
flakemetry config
flakemetry config --json
```
