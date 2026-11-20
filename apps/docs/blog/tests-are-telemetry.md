# Tests are telemetry, not reports

*Andrii Kohut · November 2026*

One of my test suites went red on 1 night out of 64. On 17 of the other 63, a test failed and a retry saved it. The job was green, the report was green, and nobody would ever have known.

That suite is XCUITest, running against a mobile app I maintain. For months I thought it was the most reliable of the four runners on that app. It looks that way if a run is a report: one document, one verdict, thrown away when the next one arrives.

A run is not a document. It is a measurement. The question that matters is rarely "what happened in this run?" It is "can I trust this test, why is it failing, and is it getting worse?" You cannot answer that from one report, however good the report is. You need the same thing you would demand from any other production system: telemetry, kept over time, with a stable identity for the thing being measured.

So I built [Flakemetry](https://github.com/AKogut/flakemetry), which models every test execution as an OpenTelemetry span. This week I finally pointed it at my own suites, and it was wrong in five different ways.

## Five things real history got right about my own tool

All of this ran for weeks against tests I had written for the tool itself. Every one of those tests passed.

**It threw away three quarters of the data, and said "uploaded".** Every job of a GitHub Actions matrix shares a run id, and I had built the idempotency key from it. The server read the second browser as a re-delivery of the first. Of 254 real batches, it stored 54. The API answered `202`, and the CLI printed `uploaded 17 execution(s)`.

**It called a regression a flake.** A test that always fails on WebKit and always passes on Chromium has different results on one commit, which is the strongest flakiness signal the model has. It scored 0.7997 against a quarantine threshold of 0.8. One tick from quarantining a real bug.

**One bad night convicted the whole suite.** On one night an emulator went wrong and 46 of 49 Espresso tests failed together. Every one of them picked up the same-commit signal. The four tests that were genuinely flaky were buried among 42 innocent ones.

**It explained things that never happened.** Reports with no retry data at all were labelled "passed on rerun", because I compared attempts across a whole commit. Twenty tests that had been skipped in all 94 runs read "recently unstable", purely from the Bayesian prior. An explainable score is worthless if the explanation is invented.

**The worst days looked like quiet days.** A hosted platform my API suite depends on started answering 500. The suite's readiness gate correctly stopped each run before any test started, so 14 runs produced no test data. In a tool that only knows about tests, that is silence.

None of these showed up in unit tests, because none of them are unit-shaped. They come from what real CI does: matrices, retries, outages, emulators that die. That is the case for trying a tool on real history before believing it, including your own.

## What the telemetry shows

The [live demo](https://akogut.github.io/flakemetry/demo/) runs on three public suites and is rebuilt every night from their CI artifacts. Nothing in it is seeded.

The same catalogue of mobile test cases runs through Appium on Android and iOS, XCUITest and Espresso. Between August and November:

| | Appium Android | Appium iOS | XCUITest | Espresso |
| --- | ---: | ---: | ---: | ---: |
| Runs | 64 | 64 | 64 | 64 |
| Went red | 10 | 3 | 1 | 8 |
| of which no test ran | 9 | 2 | 1 | 4 |
| Green only because a retry rescued it | 0 | 3 | 17 | 0 |

Read the top row alone and XCUITest wins easily. Read the bottom row and it is carrying the most hidden instability of the four. Most of Appium Android's red nights never reached a test at all: they were the emulator or the driver, not the app and not the tests. Those are different problems with different owners, and a red badge cannot tell them apart.

## Why spans

Modelling a test as a span is not about tracing for its own sake. It is what makes the rest fall out naturally:

- **History attaches to an identity,** not to a file. A test keeps its record when it moves or gets renamed.
- **Retries are attempts,** so a pass after a failure is evidence and not a success.
- **Each browser or platform is a variant,** scored on its own.
- **Every score carries its reasons.** You can read why a test is on the board and disagree with it.
- **It is OpenTelemetry,** so nothing about the data is locked in.

## Try it

The demo is at [akogut.github.io/flakemetry/demo](https://akogut.github.io/flakemetry/demo/), and [how it is built](https://github.com/AKogut/flakemetry/tree/main/examples/public-demo) is in the repository. Flakemetry is MIT-licensed and self-hosted with one `docker compose up`, with reporters for Playwright, Vitest, Jest and pytest, and importers for Allure, XCUITest and JUnit.

Point it at your own CI history. If it is wrong about your suite, I would like to know how.
