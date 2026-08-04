import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['suites/vitest/**/*.test.ts'],
    // Named by bare specifier on purpose: that is how a consumer writes it, and an
    // unresolvable specifier is skipped in silence rather than raised as an error.
    reporters: ['default', '@flakemetry/vitest-reporter'],
  },
})
