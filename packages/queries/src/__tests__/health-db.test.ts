import { type Prisma, PrismaClient } from '@flakemetry/db'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'

import { getTestHealthMetrics } from '../health'

const hasDb = Boolean(process.env.DATABASE_URL)
const prisma = new PrismaClient()

const DAY_MS = 24 * 60 * 60 * 1000
const ago = (days: number): Date => new Date(Date.now() - days * DAY_MS)
const dayOnly = (days: number): Date => {
  const date = ago(days)
  date.setUTCHours(0, 0, 0, 0)
  return date
}

describe.skipIf(!hasDb)('getTestHealthMetrics', () => {
  beforeEach(async () => {
    await prisma.testHealthEvent.deleteMany()
    await prisma.flakyTrends.deleteMany()
    await prisma.suiteDaily.deleteMany()
    await prisma.flakyScore.deleteMany()
    await prisma.testIdentity.deleteMany()
    await prisma.project.deleteMany()
    await prisma.org.deleteMany()
  })

  afterAll(async () => {
    await prisma.$disconnect()
  })

  it('computes MTTR, weekly deltas, backlog and reliability from persisted history', async () => {
    const org = await prisma.org.create({ data: { name: 'Acme', slug: `acme-${Date.now()}` } })
    const project = await prisma.project.create({
      data: { orgId: org.id, name: 'Web', slug: 'web' },
    })
    const tenant = { orgId: org.id, projectId: project.id }

    const resolved = await prisma.testIdentity.create({
      data: {
        ...tenant,
        fingerprint: 'fp-resolved',
        filePath: 'e2e/a.spec.ts',
        suite: 'auth',
        title: 'a',
      },
    })
    const open = await prisma.testIdentity.create({
      data: {
        ...tenant,
        fingerprint: 'fp-open',
        filePath: 'e2e/b.spec.ts',
        suite: 'shop',
        title: 'b',
        quarantined: true,
      },
    })

    await prisma.testHealthEvent.createMany({
      data: [
        { ...tenant, testIdentityId: resolved.id, kind: 'flaked', createdAt: ago(5) },
        { ...tenant, testIdentityId: resolved.id, kind: 'stabilized', createdAt: ago(3) },
        { ...tenant, testIdentityId: open.id, kind: 'flaked', createdAt: ago(2) },
      ],
    })

    await prisma.flakyScore.create({
      data: {
        ...tenant,
        testIdentityId: open.id,
        score: 0.8,
        flipRate: 0.4,
        passOnRerunRate: 0.6,
        sameShaVariance: 0.3,
        entropy: 0.5,
        failIsolation: 1,
        modelVersion: 'test',
        quarantineCandidate: true,
        lastFlakedAt: ago(2),
        reasonCodes: [] as Prisma.InputJsonValue,
      },
    })

    await prisma.suiteDaily.create({
      data: {
        ...tenant,
        suite: 'auth',
        day: dayOnly(1),
        total: 10,
        passed: 8,
        failed: 2,
        flaky: 0,
        skipped: 0,
        avgDurationMs: 1000,
      },
    })

    await prisma.flakyTrends.create({
      data: { ...tenant, day: dayOnly(1), flakyCount: 2, quarantinedCount: 1, avgScore: 0.4 },
    })

    const metrics = await getTestHealthMetrics(prisma, project.id, 90)

    expect(metrics.mttr.resolvedCount).toBe(1)
    expect(metrics.mttr.medianMs).toBe(2 * DAY_MS)
    expect(metrics.mttr.openCount).toBe(1)
    expect(metrics.quarantine.currentBacklog).toBe(1)
    expect(metrics.quarantine.trend).toHaveLength(1)
    expect(metrics.quarantine.trend[0]?.count).toBe(1)

    const introduced = metrics.weekly.reduce((sum, week) => sum + week.introduced, 0)
    const resolvedCount = metrics.weekly.reduce((sum, week) => sum + week.resolved, 0)
    expect(introduced).toBe(2)
    expect(resolvedCount).toBe(1)

    expect(metrics.reliabilityTrend).toHaveLength(1)
    expect(metrics.reliabilityTrend[0]?.passRate).toBeCloseTo(0.8)
  })
})
