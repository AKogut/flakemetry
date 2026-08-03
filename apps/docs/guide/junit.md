# Any runner via JUnit XML

No native reporter? Any runner that writes **JUnit XML** — pytest, Go, Ruby, JUnit,
PHPUnit, and most others — maps onto the same conventions through the CLI. A JUnit upload
yields the same intelligence as the native reporters: the cases are fed through the same
recorder, so identity, flaky scoring, and history all work identically.

## Upload in two steps

Write the results file with your runner, then upload it:

```bash
pytest --junitxml=junit.xml
npx flakemetry junit junit.xml
```

The upload reads `FLAKEMETRY_ENDPOINT` and `FLAKEMETRY_TOKEN` from the environment, or you
can pass `--endpoint` and `--token` explicitly.

## Examples by runner

```bash
# pytest
pytest --junitxml=junit.xml && npx flakemetry junit junit.xml

# Go (with gotestsum)
gotestsum --junitfile junit.xml && npx flakemetry junit junit.xml

# Ruby (RSpec + rspec_junit_formatter)
rspec --format RspecJunitFormatter --out junit.xml && npx flakemetry junit junit.xml

# PHPUnit
phpunit --log-junit junit.xml && npx flakemetry junit junit.xml
```

## How cases are mapped

Each `<testcase>` becomes a test execution:

- **suite** comes from `classname`.
- **file path** comes from the `file` attribute, or is derived from a dotted `classname`
  when `file` is absent.
- **status** is `fail` for `<failure>` or `<error>`, `skip` for `<skipped>`, otherwise
  `pass`.
- **duration** is `time` (seconds) converted to milliseconds.
- **error** carries the failure message, type, and text as the stack.

Pass `--fail-on-error` if you want the upload step itself to exit non-zero when delivery
fails; by default it never breaks your build.

## Uploading without the CLI

If your CI cannot run Node at all, post the report straight to the API — the server parses it
into exactly the same run batch the CLI would have sent:

```bash
curl -X POST "$FLAKEMETRY_ENDPOINT/v1/ingest/junit" \
  -H "Authorization: Bearer $FLAKEMETRY_TOKEN" \
  -H 'Content-Type: application/json' \
  -d "$(jq -n --arg xml "$(cat junit.xml)" '{
        idempotencyKey: "build-\($ENV.CI_RUN_ID)",
        resource: { ciProvider: "other", commitSha: $ENV.COMMIT_SHA, branch: $ENV.BRANCH, trigger: "push" },
        xml: $xml
      }')"
```

The `idempotencyKey` makes the upload safe to retry: replaying the same key is deduplicated
rather than counted twice. See the [API reference](/reference/api) for the full request schema.

::: tip Prefer a native plugin?
A native `pytest-flakemetry` plugin and a server-side JUnit endpoint are on the
[roadmap](https://github.com/users/AKogut/projects/14). Until then the CLI path above gives
Python and every other runner full parity with the native reporters.
:::
