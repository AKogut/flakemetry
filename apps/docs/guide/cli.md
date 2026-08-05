# CLI

`@flakemetry/cli` sends results and inspects configuration from any CI provider or a local
shell. Run it with `npx flakemetry <command>` or install it as a dev dependency.

All commands read `FLAKEMETRY_ENDPOINT` and `FLAKEMETRY_TOKEN` from the environment;
`--endpoint` and `--token` override them.

## `flakemetry run -- <command>`

Runs a test command, uploads whatever the reporter wrote, and exits with the command's own
code.

```bash
flakemetry run -- pnpm test
```

Two guarantees, and they are the reason to use this over two separate steps:

- **The wrapped command's exit code is the exit code.** A failing suite still fails the build.
- **An upload problem never changes that.** A dead endpoint, an expired token or a network
  blip warns on stderr and leaves the build's verdict alone. Observability must not become a
  source of CI failures.

Results are uploaded whether the suite passed or failed — they are most worth having when it
failed.

If no results file exists, it says so and does nothing. Wrapping a suite whose reporter is not
configured yet is ordinary, not an error.

## `flakemetry flaky`

Lists flaky tests for the project, worst first. Needs a token with the **`read`** scope — see
the [read API](/reference/api).

```bash
flakemetry flaky --limit 10
flakemetry flaky --quarantined
flakemetry flaky --min-score 0.7 --owner @acme/web
flakemetry flaky --json | jq '.[] | select(.score > 0.8) | .title'
```

`--json` prints the rows unchanged, for scripting.

## `flakemetry quarantine`

Quarantines a test so it stops failing the build, releases one, or hands it back to the
scorer. Needs a token with the **`quarantine`** scope.

```bash
flakemetry quarantine <testIdentityId> --reason "known bad, tracked in JIRA-123"
flakemetry quarantine <testIdentityId> --release
flakemetry quarantine <testIdentityId> --auto
```

Its own scope, deliberately. Quarantining is the one call that can hide a real regression, so
neither a token that reads a dashboard nor the one pasted into every CI job in the company
gets to make that decision.

**A person's decision sticks.** While a test is quarantined or released by hand, the scorer
stops moving it — in both directions. Otherwise the next run would silently undo you: a
manually quarantined test that the scorer does not consider flaky gets released, and a
manually released test that it does gets quarantined again.

`--auto` gives the test back. The current state is left alone and the scorer takes over from
the next run: the cooldown that decides when a quarantined test is safe to release needs run
history, and guessing here would be a second copy of that rule, free to drift from the first.

## `flakemetry doctor`

Checks the configuration file, the endpoint, whether it answers, and what the token is
allowed to do.

```
✓ endpoint: https://flakemetry.internal
✓ reachable: answered 200
✓ token: present (fmk_…037e)
! read scope: valid token without the read scope — uploads will work, queries will not
```

The token is always redacted: this is the command people paste into a chat when something is
wrong.

A missing **read** scope is a warning, not a failure, and `doctor` still exits `0` — an
upload-only token is a perfectly good CI setup, and failing would break the pipeline that has
one. Only a missing endpoint, an unreachable server or a rejected token exit non-zero.

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
