import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['suites/sharded/vitest/**/*.test.ts'],
    reporters: ['default', '@flakemetry/vitest-reporter'],
  },
})
