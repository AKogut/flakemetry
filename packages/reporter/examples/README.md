# Example: wiring the Flakemetry reporter

```ts
// playwright.config.ts
import { defineConfig } from '@playwright/test'

export default defineConfig({
  reporter: [['@flakemetry/playwright-reporter']],
})
```

Configure via environment variables:

```bash
FLAKEMETRY_ENDPOINT=https://ingest.example.com \
FLAKEMETRY_TOKEN=fmk_xxx \
FLAKEMETRY_PROJECT=acme/web \
  npx playwright test
```

Off CI or without a token the reporter is a no-op on delivery (fail-open). Set `FLAKEMETRY_OUTPUT_FILE=batch.json` to write the ingest batch to disk for inspection.
