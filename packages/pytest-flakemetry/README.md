# pytest-flakemetry

Report pytest runs to [Flakemetry](https://akogut.github.io/flakemetry/) — OpenTelemetry-native
test intelligence with explainable flaky detection and AI root-cause analysis.

This is the native pytest plugin. It records richer detail than the
[JUnit XML path](https://akogut.github.io/flakemetry/guide/junit): parameter values travel as
structured params rather than being baked into the test name, and retries are recognised as
retries, so a test that passes on rerun is reported as **flaky** rather than as a pass.

## Install

```bash
pip install pytest-flakemetry
```

The plugin registers itself; there is nothing to add to `conftest.py`.

## Use

```bash
export FLAKEMETRY_ENDPOINT=https://ingest.flakemetry.example.com
export FLAKEMETRY_TOKEN=fmk_...
pytest
```

Or pass them explicitly, and write the batch to a file instead of uploading it:

```bash
pytest --flakemetry-endpoint "$ENDPOINT" --flakemetry-token "$TOKEN"
pytest --flakemetry-output flakemetry-results.json
```

| Option | Environment | Purpose |
| --- | --- | --- |
| `--flakemetry-endpoint` | `FLAKEMETRY_ENDPOINT` | Ingestion API base URL |
| `--flakemetry-token` | `FLAKEMETRY_TOKEN` | Per-project ingest token |
| `--flakemetry-output` | `FLAKEMETRY_OUTPUT_FILE` | Write the run batch to this file |

Run context is read from the environment the same way the JavaScript reporters read it:
`GITHUB_SHA`, `GITHUB_REF_NAME`, `GITHUB_RUN_ID` and friends on GitHub Actions, with
`FLAKEMETRY_COMMIT_SHA`, `FLAKEMETRY_BRANCH` and `FLAKEMETRY_IDEMPOTENCY_KEY` as overrides
anywhere else.

## Flaky detection

Install [`pytest-rerunfailures`](https://pypi.org/project/pytest-rerunfailures/) and run with
`--reruns`. A test that fails and then passes on a retry is reported as `flaky`, which is the
strongest single signal the scoring model consumes.

```bash
pip install pytest-rerunfailures
pytest --reruns 2
```

## Delivery never fails your build

Upload problems — an unreachable endpoint, a rejected token, a timeout — are written to stderr
and swallowed. A Flakemetry outage cannot turn a green test run red.

## Development

```bash
python -m venv .venv && .venv/bin/pip install -e ".[dev]"
.venv/bin/pytest
```
