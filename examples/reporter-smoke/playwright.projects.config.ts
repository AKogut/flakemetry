import { defineConfig } from '@playwright/test'

export default defineConfig({
  testDir: './suites/playwright-projects',
  reporter: [['list'], ['@flakemetry/playwright-reporter']],
  projects: [{ name: 'chromium' }, { name: 'firefox' }, { name: 'webkit' }],
})
