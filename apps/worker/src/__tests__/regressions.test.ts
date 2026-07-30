import { PrismaClient } from '@flakemetry/db'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'

import { detectRegressions, detectSuiteRegressions, type SuiteDayRow } from '../regressions'

const hasDb = Boolean(process.env.DATABASE_URL)
const prisma = new PrismaClient()

const row = (
  suite: string,
  day: string,
  total: number,
  failed: number,
  flaky = 0,
): SuiteDayRow => ({
  suite,
  day,
  total,
  failed,
  flaky,
})

describe('detectRegressions', () => {
  it('flags a suite whose fail rate jumps above its baseline', () => {
    const rows = [
      row('checkout', '2026-07-27', 40, 0),
      row('checkout', '2026-07-28', 40, 1),
      row('checkout', '2026-07-29', 40, 20),
    ]
    const regressions = detectRegressions(rows, '2026-07-29')
    expect(regressions).toHaveLength(1)
    expect(regressions[0]?.suite).toBe('checkout')
    expect(regressions[0]?.failRate).toBe(0.5)
    expect(regressions[0]?.baselineFailRate).toBeLessThan(0.05)
  })

  it('ignores a suite with too few executions today', () => {
    const rows = [row('auth', '2026-07-28', 40, 0), row('auth', '2026-07-29', 5, 5)]
    expect(detectRegressions(rows, '2026-07-29', { minTotal: 20 })).toHaveLength(0)
  })

  it('ignores a small jump under the delta threshold', () => {
    const rows = [row('auth', '2026-07-28', 40, 4), row('auth', '2026-07-29', 40, 8)]
    expect(detectRegressions(rows, '2026-07-29')).toHaveLength(0)
  })

  it('needs prior history to compare against', () => {
    expect(detectRegressions([row('auth', '2026-07-29', 40, 30)], '2026-07-29')).toHaveLength(0)
  })
})

describe.skipIf(!hasDb)('detectSuiteRegressions', () => {
  beforeEach(async () => {
    await prisma.suiteDaily.deleteMany()
    await prisma.project.deleteMany()
    await prisma.org.deleteMany()
  })

  afterAll(async () => {
    await prisma.$disconnect()
  })

  it('reads suite_daily and reports the regressed suite', async () => {
    const org = await prisma.org.create({ data: { name: 'Acme', slug: `acme-${Date.now()}` } })
    const project = await prisma.project.create({
      data: { orgId: org.id, name: 'Web', slug: 'web' },
    })
    const tenant = { orgId: org.id, projectId: project.id }
    const at = (iso: string) => new Date(`${iso}T00:00:00Z`)
    await prisma.suiteDaily.createMany({
      data: [
        { ...tenant, suite: 'checkout', day: at('2026-07-27'), total: 40, passed: 40, failed: 0 },
        { ...tenant, suite: 'checkout', day: at('2026-07-28'), total: 40, passed: 39, failed: 1 },
        { ...tenant, suite: 'checkout', day: at('2026-07-29'), total: 40, passed: 18, failed: 22 },
      ],
    })

    const regressions = await detectSuiteRegressions(prisma, project.id, at('2026-07-29'))
    expect(regressions).toHaveLength(1)
    expect(regressions[0]?.suite).toBe('checkout')
  })
})
