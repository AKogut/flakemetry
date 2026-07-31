# GitHub Action

The GitHub Action wires Flakemetry into CI: it uploads results, comments a sticky flaky
summary on the PR, and runs a quality gate — each step runs even when tests fail and never
blocks the build unless you ask it to.

## Full workflow

Let the test step write the results file, then upload it:

```yaml
- name: Run tests
  run: npx playwright test
  env:
    FLAKEMETRY_OUTPUT_FILE: flakemetry-results.json

- name: Upload to Flakemetry
  if: always()
  uses: AKogut/flakemetry/.github/actions/flakemetry@main
  with:
    token: ${{ secrets.FLAKEMETRY_TOKEN }}
    endpoint: ${{ secrets.FLAKEMETRY_ENDPOINT }}

- name: Comment flaky summary on the PR
  if: always()
  uses: AKogut/flakemetry/.github/actions/flakemetry-pr-comment@main
  with:
    token: ${{ secrets.FLAKEMETRY_TOKEN }}
    endpoint: ${{ secrets.FLAKEMETRY_ENDPOINT }}

- name: Quality gate — block only new failures
  if: always()
  uses: AKogut/flakemetry/.github/actions/flakemetry-gate@main
  with:
    token: ${{ secrets.FLAKEMETRY_TOKEN }}
    endpoint: ${{ secrets.FLAKEMETRY_ENDPOINT }}
    strictness: new
```

## The sticky comment

The comment step needs `permissions: pull-requests: write` on the job. It posts one sticky
comment and updates it on every run; it never fails the build.

## The quality gate

The gate compares the PR run against the base branch and distinguishes _new_ failures this
change introduced from tests that already flake on the base. It posts a sticky verdict
comment, sets a `flakemetry/gate` commit status, and fails the step only on new failures
(`strictness: new`) — flip to `any` to block known flakes too, or `off` for report-only. It
needs `permissions: pull-requests: write` and `statuses: write`.

## Inline annotations

The gate also emits per-test workflow annotations that show inline in the PR: an error on
each new failure, and a non-blocking warning on each known flake — or a distinct notice
reading `test X is quarantined (flaky score 0.86) — not blocking this build` for
auto-quarantined tests, so a quarantined flaky test visibly stops failing the build with a
clear trail.

## Prefer your own tooling?

`flakemetry upload flakemetry-results.json` from
[`@flakemetry/cli`](/guide/cli) does the same over any CI provider, reading
`FLAKEMETRY_ENDPOINT` and `FLAKEMETRY_TOKEN` from the environment.
