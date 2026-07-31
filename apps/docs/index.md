---
layout: home

hero:
  name: Flakemetry
  text: Test intelligence, OpenTelemetry-native
  tagline: Treat every test run as a trace, not a report. Explainable flaky detection and AI root-cause across every run, branch, and refactor.
  actions:
    - theme: brand
      text: Get started
      link: /guide/introduction
    - theme: alt
      text: Self-host
      link: /guide/self-hosting
    - theme: alt
      text: View on GitHub
      link: https://github.com/AKogut/flakemetry

features:
  - title: Test observability
    details: Every run ingested as OTLP — full history per test, not per report. Historical analytics fall out of the telemetry instead of being bolted on.
  - title: Stable test identity
    details: A multi-level fingerprint that survives file moves, renames, and parameterization, so a flaky test does not reset to zero when a file moves.
  - title: Explainable flaky scoring
    details: A transparent Beta-Binomial score with human-readable reason codes — same commit different result, pass-on-rerun, and more. Not a black box.
  - title: AI root-cause
    details: Failures are normalized and clustered cheaply; only genuinely new signatures reach an LLM, budget-gated and cached per cluster.
  - title: CI-native, never blocks
    details: The write path returns 202 instantly and does the heavy work asynchronously. A GitHub Action and sticky PR comment ship out of the box.
  - title: Works with any runner
    details: Native reporters for Playwright, Vitest, and Jest — plus JUnit XML ingestion for pytest, Go, Ruby, PHPUnit, and anything else.
---

## Why Flakemetry

Test reporters answer _"what happened in this run?"_ Flakemetry answers
**_"is this test trustworthy, why is it failing, and is it getting worse?"_** — across
every run, branch, and refactor.

If every test execution is modelled as an **OpenTelemetry span**, then historical
analytics, flaky scoring, and AI root-cause become natural extensions of the telemetry
instead of bolted-on hacks. That single decision is the platform's technical moat.

Ready to try it? [Self-host in one command](/guide/self-hosting), then
[send your first run](/guide/reporters).
