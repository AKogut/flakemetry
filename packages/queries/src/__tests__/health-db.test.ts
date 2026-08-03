import { type Prisma, PrismaClient } from '@flakemetry/db'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'

import { getTeamHealthLeaderboard, getTestHealthMetrics } from '../health'

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

describe.skipIf(!hasDb)('team-scoped health metrics', () => {
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

  const seedTeams = async () => {
    const org = await prisma.org.create({ data: { name: 'Acme', slug: `acme-${Date.now()}` } })
    const project = await prisma.project.create({
      data: {
        orgId: org.id,
        name: 'Web',
        slug: 'web',
        codeowners: 'e2e/checkout/* @acme/payments\ne2e/auth/* @acme/identity\n',
      },
    })
    const tenant = { orgId: org.id, projectId: project.id }

    const make = (fingerprint: string, filePath: string, quarantined = false) =>
      prisma.testIdentity.create({
        data: { ...tenant, fingerprint, filePath, suite: 's', title: fingerprint, quarantined },
      })

    const payments = await make('pay', 'e2e/checkout/pay.spec.ts', true)
    const second = await make('refund', 'e2e/checkout/refund.spec.ts')
    const identity = await make('login', 'e2e/auth/login.spec.ts')

    await prisma.testHealthEvent.createMany({
      data: [
        { ...tenant, testIdentityId: payments.id, kind: 'flaked', createdAt: ago(6) },
        { ...tenant, testIdentityId: payments.id, kind: 'stabilized', createdAt: ago(3) },
        { ...tenant, testIdentityId: payments.id, kind: 'flaked', createdAt: ago(2) },
        { ...tenant, testIdentityId: second.id, kind: 'flaked', createdAt: ago(5) },
        { ...tenant, testIdentityId: identity.id, kind: 'flaked', createdAt: ago(4) },
      ],
    })

    return { projectId: project.id, paymentsId: payments.id }
  }

  it('scopes MTTR, backlog and weekly counts to the owning team', async () => {
    const s = await seedTeams()

    const all = await getTestHealthMetrics(prisma, s.projectId, 90)
    const payments = await getTestHealthMetrics(prisma, s.projectId, 90, '@acme/payments')

    expect(all.weekly.reduce((sum, week) => sum + week.introduced, 0)).toBe(4)
    expect(payments.weekly.reduce((sum, week) => sum + week.introduced, 0)).toBe(3)
    expect(payments.mttr.resolvedCount).toBe(1)
    expect(payments.quarantine.currentBacklog).toBe(1)

    const identity = await getTestHealthMetrics(prisma, s.projectId, 90, '@acme/identity')
    expect(identity.mttr.resolvedCount).toBe(0)
    expect(identity.quarantine.currentBacklog).toBe(0)
  })

  it('returns empty metrics for an owner that owns nothing', async () => {
    const s = await seedTeams()
    const none = await getTestHealthMetrics(prisma, s.projectId, 90, '@acme/nobody')
    expect(none.mttr.resolvedCount).toBe(0)
    expect(none.quarantine.currentBacklog).toBe(0)
    expect(none.reliabilityTrend).toEqual([])
  })

  it('ranks teams by net flaky backlog', async () => {
    const s = await seedTeams()
    const teams = await getTeamHealthLeaderboard(prisma, s.projectId, 90)

    const payments = teams.find((team) => team.owner === '@acme/payments')
    expect(payments?.introduced).toBe(3)
    expect(payments?.resolved).toBe(1)
    expect(payments?.net).toBe(2)
    expect(payments?.quarantined).toBe(1)
    // payments is going backwards fastest (net +2 against identity's +1), so it leads.
    expect(teams[0]?.owner).toBe('@acme/payments')
    expect(teams.find((team) => team.owner === '@acme/identity')?.net).toBe(1)
  })
})
