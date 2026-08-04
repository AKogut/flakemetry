import { defineConfig } from '@playwright/test'

export default defineConfig({
  testDir: './suites/playwright',
  reporter: [['list'], ['@flakemetry/playwright-reporter']],
})
