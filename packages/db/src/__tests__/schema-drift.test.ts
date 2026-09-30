import { execFileSync } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

const packageDir = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const hasDb = Boolean(process.env.DATABASE_URL)

describe.skipIf(!hasDb)('schema.prisma and the migrations', () => {
  it('describe the same database, so the next generated migration contains only what was asked for', () => {
    let diff = ''
    let status = 0
    try {
      diff = execFileSync(
        'pnpm',
        [
          'exec',
          'prisma',
          'migrate',
          'diff',
          '--from-config-datasource',
          '--to-schema',
          'prisma/schema.prisma',
          '--script',
          '--exit-code',
        ],
        { cwd: packageDir, env: process.env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
      )
    } catch (error) {
      const failed = error as { status?: number; stdout?: string }
      status = failed.status ?? 1
      diff = failed.stdout ?? ''
    }

    expect(status, `prisma would generate this on top of the migrations:\n${diff}`).toBe(0)
  }, 60_000)
})
