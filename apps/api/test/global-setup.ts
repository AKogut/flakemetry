import { execSync } from 'node:child_process'

export default function setup(): void {
  const base = process.env.DATABASE_URL
  if (!base) return
  const url = new URL(base)
  url.searchParams.set('schema', 'flakemetry_test_api')
  execSync('pnpm --filter @flakemetry/db exec prisma migrate deploy', {
    stdio: 'inherit',
    env: { ...process.env, DATABASE_URL: url.toString() },
  })
}
