# Recording the demo GIF

`docs/demo.gif` is a slideshow of the [public demo](https://akogut.github.io/flakemetry/demo/), so what it shows is real CI history:

1. the suites and what they add up to
2. one app on four runners, with the retries a job status hides
3. the flaky board
4. one test: its score, its reasons and its history
5. runs where no test ran, during an outage of the platform under test
6. one test as a trace

It is generated headlessly, with no manual screen capture, so it stays reproducible as the dashboard changes.

## Prerequisites

`ffmpeg` and a Playwright Chromium build:

```bash
pnpm --filter flakemetry-public-demo exec playwright-core install chromium
```

## Record it

```bash
pnpm --filter flakemetry-public-demo record "$PWD/docs/demo.gif"
```

A second argument records from another copy of the snapshot, such as one you have just built and are serving locally.

Check that it reads at the size GitHub shows it, then commit it. Frame order and timing are at the top of [`record-gif.mjs`](../examples/public-demo/record-gif.mjs).

## The video

`apps/docs/public/flakemetry-demo.mp4` is a captioned walkthrough of about a minute, made the same way:

```bash
pnpm --filter flakemetry-public-demo record:video "$PWD/apps/docs/public/flakemetry-demo.mp4"
```

Captions and timing are in [`record-video.mjs`](../examples/public-demo/record-video.mjs). They name no numbers, so the video does not go stale as nights are added.

