import { randomUUID } from 'node:crypto'

import { PrismaClient } from '@flakemetry/db'
import { afterAll, describe, expect, it } from 'vitest'

import { ciSpendOf, getFlakinessCost, peopleSpendOf } from '../cost'

const hasDb = Boolean(process.env.DATABASE_URL)
const prisma = new PrismaClient()

const NOW = new Date('2026-08-05T12:00:00Z')
const RATES = { ciMinuteCost: 0.01, developerHourCost: 120, investigationMinutes: 15 }

const seedProject = async () => {
  const slug = `cost-${randomUUID().slice(0, 8)}`
  const org = await prisma.org.create({ data: { name: slug, slug } })
  const project = await prisma.project.create({ data: { orgId: org.id, name: slug, slug } })
  return { orgId: org.id, projectId: project.id }
}

const seedTest = async (
  tenant: { orgId: string; projectId: string },
  title: string,
  quarantined = false,
) =>
  prisma.testIdentity.create({
    data: {
      ...tenant,
      fingerprint: randomUUID(),
      filePath: 'src/a.spec.ts',
      suite: 'checkout',
      title,
      quarantined,
    },
  })

const seedDay = async (
  tenant: { orgId: string; projectId: string },
  testIdentityId: string,
  day: string,
  stats: { rerunCount?: number; rerunMs?: number; flaky?: number },
) =>
  prisma.dailyTestStats.create({
    data: {
      ...tenant,
      testIdentityId,
      day: new Date(day),
      total: 10,
      passed: 10,
      rerunCount: stats.rerunCount ?? 0,
      rerunMs: stats.rerunMs ?? 0,
      flaky: stats.flaky ?? 0,
    },
  })

describe('cost arithmetic', () => {
  it('turns rerun wall-clock into money at the configured rate', () => {
    // Ten minutes of reruns at a cent a minute.
    expect(ciSpendOf(600_000, RATES)).toBeCloseTo(0.1)
  })

  it('prices an interruption at the configured investigation length', () => {
    // Four occurrences x 15 minutes = one hour.
    expect(peopleSpendOf(4, RATES)).toBeCloseTo(120)
  })

  it('costs nothing when the rates are zero', () => {
    const free = { ciMinuteCost: 0, developerHourCost: 0, investigationMinutes: 0 }
    expect(ciSpendOf(600_000, free)).toBe(0)
    expect(peopleSpendOf(10, free)).toBe(0)
  })
})

describe.skipIf(!hasDb)('getFlakinessCost', () => {
  afterAll(async () => {
    await prisma.$disconnect()
  })

  it('adds up rerun time and interruptions across the window', async () => {
    const tenant = await seedProject()
    const test = await seedTest(tenant, 'pays')
    await seedDay(tenant, test.id, '2026-08-04', { rerunCount: 2, rerunMs: 300_000, flaky: 2 })
    await seedDay(tenant, test.id, '2026-08-05', { rerunCount: 1, rerunMs: 300_000, flaky: 2 })

    const cost = await getFlakinessCost(prisma, tenant.projectId, 7, RATES, NOW)

    expect(cost.totals.rerunCount).toBe(3)
    expect(cost.totals.rerunMs).toBe(600_000)
    expect(cost.totals.flakyOccurrences).toBe(4)
    expect(cost.totals.ciSpend).toBeCloseTo(0.1)
    expect(cost.totals.peopleSpend).toBeCloseTo(120)
    expect(cost.totals.totalSpend).toBeCloseTo(120.1)
  })

  it('leaves out days older than the window', async () => {
    const tenant = await seedProject()
    const test = await seedTest(tenant, 'pays')
    await seedDay(tenant, test.id, '2026-08-05', { rerunCount: 1, rerunMs: 60_000 })
    await seedDay(tenant, test.id, '2026-06-01', { rerunCount: 99, rerunMs: 99_000_000 })

    const cost = await getFlakinessCost(prisma, tenant.projectId, 7, RATES, NOW)

    expect(cost.totals.rerunCount).toBe(1)
  })

  it('ranks offenders by what they cost, not by how often they reran', async () => {
    const tenant = await seedProject()
    const slow = await seedTest(tenant, 'slow but rare')
    const chatty = await seedTest(tenant, 'quick but constant')
    await seedDay(tenant, slow.id, '2026-08-05', { rerunCount: 1, rerunMs: 1_200_000 })
    await seedDay(tenant, chatty.id, '2026-08-05', { rerunCount: 20, rerunMs: 20_000 })

    const cost = await getFlakinessCost(prisma, tenant.projectId, 7, RATES, NOW)

    // A single twenty-minute rerun burns more of the CI bill than twenty one-second ones,
    // and the point of the panel is to say where the money went.
    expect(cost.offenders[0]?.title).toBe('slow but rare')
  })

  it('omits tests that never reran and never flaked', async () => {
    const tenant = await seedProject()
    const healthy = await seedTest(tenant, 'always green')
    await seedDay(tenant, healthy.id, '2026-08-05', {})

    const cost = await getFlakinessCost(prisma, tenant.projectId, 7, RATES, NOW)

    expect(cost.offenders).toHaveLength(0)
  })

  it('counts only the interruption as avoided by quarantine, never the CI time', async () => {
    const tenant = await seedProject()
    const quarantined = await seedTest(tenant, 'known bad', true)
    await seedDay(tenant, quarantined.id, '2026-08-05', {
      rerunCount: 4,
      rerunMs: 600_000,
      flaky: 4,
    })

    const cost = await getFlakinessCost(prisma, tenant.projectId, 7, RATES, NOW)

    // Quarantine stops a test blocking a build; it does not stop the test running. Claiming
    // the CI minutes back would be a number that falls apart the first time it is questioned.
    expect(cost.avoided.quarantinedTests).toBe(1)
    expect(cost.avoided.peopleSpend).toBeCloseTo(120)
    expect(cost.totals.ciSpend).toBeCloseTo(0.1)
    expect(cost.avoided).not.toHaveProperty('ciSpend')
  })

  it('does not bill one project for another project flakes', async () => {
    const mine = await seedProject()
    const theirs = await seedProject()
    const theirTest = await seedTest(theirs, 'not mine')
    await seedDay(theirs, theirTest.id, '2026-08-05', { rerunCount: 9, rerunMs: 900_000, flaky: 9 })

    const cost = await getFlakinessCost(prisma, mine.projectId, 7, RATES, NOW)

    expect(cost.totals.rerunMs).toBe(0)
    expect(cost.totals.totalSpend).toBe(0)
  })

  it('reports a daily trend in order', async () => {
    const tenant = await seedProject()
    const test = await seedTest(tenant, 'pays')
    await seedDay(tenant, test.id, '2026-08-03', { rerunMs: 60_000 })
    await seedDay(tenant, test.id, '2026-08-05', { rerunMs: 120_000 })

    const cost = await getFlakinessCost(prisma, tenant.projectId, 7, RATES, NOW)

    expect(cost.trend.map((entry) => entry.rerunMs)).toEqual([60_000, 120_000])
  })
})
