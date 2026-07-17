import { execSync } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

export default function setup(): void {
  const base = process.env.DATABASE_URL
  if (!base) return
  const url = new URL(base)
  url.searchParams.set('schema', 'flakemetry_test_db')
  const schema = join(dirname(fileURLToPath(import.meta.url)), '..', 'prisma', 'schema.prisma')
  execSync(`pnpm exec prisma migrate deploy --schema "${schema}"`, {
    stdio: 'inherit',
    env: { ...process.env, DATABASE_URL: url.toString() },
  })
}
