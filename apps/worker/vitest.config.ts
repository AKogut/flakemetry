import { defineConfig } from 'vitest/config'

const base = process.env.DATABASE_URL
const withSchema = (url: string): string => {
  const parsed = new URL(url)
  parsed.searchParams.set('schema', 'flakemetry_test_worker')
  return parsed.toString()
}

export default defineConfig({
  test: {
    fileParallelism: false,
    globalSetup: ['./test/global-setup.ts'],
    env: base ? { DATABASE_URL: withSchema(base) } : {},
  },
})
