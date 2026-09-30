import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['suites/**/*.test.ts'],
    reporters: ['default', '@flakemetry/vitest-reporter'],
  },
})
