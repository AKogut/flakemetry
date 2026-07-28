import { defineConfig } from '@playwright/test'

export default defineConfig({
  testDir: './tests',
  // Retries turn a fail-then-pass into a "flaky" outcome — exactly what
  // Flakemetry is built to detect. The reporter records every attempt.
  retries: 2,
  reporter: [
    ['list'],
    // Writes the run to FLAKEMETRY_OUTPUT_FILE and, when FLAKEMETRY_ENDPOINT +
    // FLAKEMETRY_TOKEN are set, uploads it. See this folder's README.
    ['@flakemetry/playwright-reporter'],
  ],
})
