# Flakemetry Playwright demo

A four-test Playwright suite that produces one of every outcome Flakemetry is built to surface:

| Test | Behaviour | What the dashboard shows |
|---|---|---|
| `checkout › renders the total` | always passes | a stable, trustworthy test |
| `checkout › shows the panel after loading` | timing race | genuinely flaky, high score |
| `auth › logs in` | fails then passes on retry | flaky (pass-on-rerun) |
| `orders › creates an order` | always fails, same error | a regression → AI RCA target |

## Run it

```bash
pnpm install
pnpm exec playwright install chromium
pnpm test
```

That runs the suite locally and prints the flaky/failed results. Nothing is sent anywhere yet.

## Send it to Flakemetry

Point the reporter at a running instance (see the repo root `docker compose up`) and give it an
ingest token from the dashboard:

```bash
FLAKEMETRY_ENDPOINT=http://localhost:4000 \
FLAKEMETRY_TOKEN=fmk_... \
pnpm test
```

Or, to decouple sending from the test run (recommended for CI), write the results to a file and
upload them in a separate step:

```bash
FLAKEMETRY_OUTPUT_FILE=flakemetry-results.json pnpm test
FLAKEMETRY_ENDPOINT=http://localhost:4000 FLAKEMETRY_TOKEN=fmk_... \
  npx @flakemetry/cli upload flakemetry-results.json
```

Run it a handful of times (the race and the retry-flake vary run to run), then open the dashboard:
the **Flaky board** ranks the two flaky tests, **test detail** explains the score with reason codes,
and — with an AI provider configured — the **RCA panel** explains the `orders` regression.
