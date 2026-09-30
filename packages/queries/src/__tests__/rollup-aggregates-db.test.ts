import { randomUUID } from 'node:crypto'

import { createPrismaClient } from '@flakemetry/db'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { ciSpendOf, getFlakinessCost, peopleSpendOf } from '../cost'
import { getDailyTrend, getProjectHealthKpis, getTestLeaderboards } from '../trends'

const hasDb = Boolean(process.env.DATABASE_URL)
const prisma = createPrismaClient()

const DAY_MS = 24 * 60 * 60 * 1000
const TESTS = 120
const DAYS = 20
const rates = { ciMinuteCost: 0.008, developerHourCost: 75, investigationMinutes: 20 }

let seed = 7
const random = (max: number): number => {
  seed = (seed * 1103515245 + 12345) % 2147483648
  return seed % max
}

interface Row {
  testIdentityId: string
  title: string
  suite: string
  filePath: string
  quarantined: boolean
  day: Date
  total: number
  passed: number
  failed: number
  flaky: number
  avgDurationMs: number
  rerunCount: number
  rerunMs: number
}

const utcDay = (daysAgo: number): Date => {
  const day = new Date(Date.now() - daysAgo * DAY_MS)
  day.setUTCHours(0, 0, 0, 0)
  return day
}

const rows: Row[] = []
let projectId = ''

const sum = (values: number[]): number => values.reduce((total, value) => total + value, 0)
const round = (value: number): number => Math.round(value * 100) / 100
const inWindow = (days: number) => (row: Row) => row.day >= utcDay(days)

describe.skipIf(!hasDb)('rollup panels aggregated in SQL', () => {
  beforeAll(async () => {
    const org = await prisma.org.create({
      data: { name: 'Rollups', slug: `rollups-${randomUUID().slice(0, 8)}` },
    })
    const project = await prisma.project.create({
      data: { orgId: org.id, name: 'Web', slug: 'web' },
    })
    projectId = project.id
    const other = await prisma.project.create({
      data: { orgId: org.id, name: 'Other', slug: 'other' },
    })

    for (let index = 0; index < TESTS; index += 1) {
      const identity = await prisma.testIdentity.create({
        data: {
          orgId: org.id,
          projectId,
          fingerprint: `fp-${index}`,
          filePath: `tests/${index % 9}.spec.ts`,
          suite: `suite-${index % 6}`,
          title: `test ${index}`,
          quarantined: index % 11 === 0,
        },
      })
      for (let daysAgo = 0; daysAgo < DAYS; daysAgo += 1) {
        if (random(5) === 0) continue
        const total = 1 + random(40)
        const failed = random(3) === 0 ? random(Math.min(total, 4) + 1) : 0
        const flaky = random(4) === 0 ? random(Math.min(total - failed, 3) + 1) : 0
        const rerunCount = flaky + random(2)
        rows.push({
          testIdentityId: identity.id,
          title: identity.title,
          suite: identity.suite,
          filePath: identity.filePath,
          quarantined: identity.quarantined,
          day: utcDay(daysAgo),
          total,
          passed: total - failed - flaky,
          failed,
          flaky,
          avgDurationMs: 50 + random(9000),
          rerunCount,
          rerunMs: rerunCount * (100 + random(20_000)),
        })
      }
    }

    await prisma.dailyTestStats.createMany({
      data: rows.map((row) => ({
        orgId: org.id,
        projectId,
        testIdentityId: row.testIdentityId,
        day: row.day,
        total: row.total,
        passed: row.passed,
        failed: row.failed,
        flaky: row.flaky,
        skipped: 0,
        avgDurationMs: row.avgDurationMs,
        rerunCount: row.rerunCount,
        rerunMs: row.rerunMs,
        updatedAt: new Date(),
      })),
    })

    const stranger = await prisma.testIdentity.create({
      data: {
        orgId: org.id,
        projectId: other.id,
        fingerprint: 'x',
        filePath: 'x',
        suite: 'x',
        title: 'x',
      },
    })
    await prisma.dailyTestStats.create({
      data: {
        orgId: org.id,
        projectId: other.id,
        testIdentityId: stranger.id,
        day: utcDay(0),
        total: 1000,
        passed: 0,
        failed: 1000,
        flaky: 0,
        avgDurationMs: 60_000,
        rerunCount: 1000,
        rerunMs: 60_000_000,
        updatedAt: new Date(),
      },
    })
  })

  afterAll(async () => {
    await prisma.$disconnect()
  })

  it('reports the same KPIs as adding the rows up one by one', async () => {
    const window = rows.filter(inWindow(14))
    const total = sum(window.map((row) => row.total))
    const duration = sum(window.map((row) => row.avgDurationMs * row.total))

    expect(await getProjectHealthKpis(prisma, projectId, 14)).toEqual({
      totalExecutions: total,
      passRate: sum(window.map((row) => row.passed)) / total,
      flakyRate: sum(window.map((row) => row.flaky)) / total,
      failRate: sum(window.map((row) => row.failed)) / total,
      avgDurationMs: Math.round(duration / total),
      totalDurationMs: duration,
    })
  })

  it('reports the same daily trend, one point per day in order', async () => {
    const window = rows.filter(inWindow(14))
    const days = [...new Set(window.map((row) => row.day.toISOString().slice(0, 10)))].sort()
    const expected = days.map((day) => {
      const onDay = window.filter((row) => row.day.toISOString().slice(0, 10) === day)
      const total = sum(onDay.map((row) => row.total))
      return {
        day,
        total,
        passRate: sum(onDay.map((row) => row.passed)) / total,
        flakyRate: sum(onDay.map((row) => row.flaky)) / total,
        avgDurationMs: Math.round(sum(onDay.map((row) => row.avgDurationMs * row.total)) / total),
      }
    })

    expect(await getDailyTrend(prisma, projectId, 14)).toEqual(expected)
  })

  it('ranks the same slowest and most failing tests', async () => {
    const byTest = new Map<string, Row[]>()
    for (const row of rows.filter(inWindow(14))) {
      byTest.set(row.testIdentityId, [...(byTest.get(row.testIdentityId) ?? []), row])
    }
    const tests = [...byTest.entries()].map(([testIdentityId, own]) => {
      const total = sum(own.map((row) => row.total))
      const failed = sum(own.map((row) => row.failed))
      const flaky = sum(own.map((row) => row.flaky))
      return {
        testIdentityId,
        title: own[0]!.title,
        suite: own[0]!.suite,
        filePath: own[0]!.filePath,
        total,
        failed,
        flaky,
        failRate: (failed + flaky) / total,
        avgDurationMs: Math.round(sum(own.map((row) => row.avgDurationMs * row.total)) / total),
      }
    })
    const byId = (left: { testIdentityId: string }, right: { testIdentityId: string }) =>
      left.testIdentityId < right.testIdentityId ? -1 : 1

    expect(await getTestLeaderboards(prisma, projectId, 14, 8)).toEqual({
      slowest: [...tests]
        .sort((a, b) => b.avgDurationMs - a.avgDurationMs || byId(a, b))
        .slice(0, 8),
      mostFailing: tests
        .filter((test) => test.failed + test.flaky > 0)
        .sort((a, b) => b.failRate - a.failRate || b.failed - a.failed || byId(a, b))
        .slice(0, 8),
    })
  })

  it('costs the same, offenders and avoided spend included', async () => {
    const now = new Date()
    const window = rows.filter(inWindow(29))
    const rerunMs = sum(window.map((row) => row.rerunMs))
    const flaky = sum(window.map((row) => row.flaky))
    const quarantined = window.filter((row) => row.quarantined)

    const cost = await getFlakinessCost(prisma, projectId, 30, rates, now)

    expect(cost.totals).toEqual({
      rerunCount: sum(window.map((row) => row.rerunCount)),
      rerunMs,
      flakyOccurrences: flaky,
      ciSpend: round(ciSpendOf(rerunMs, rates)),
      peopleSpend: round(peopleSpendOf(flaky, rates)),
      totalSpend: round(round(ciSpendOf(rerunMs, rates)) + round(peopleSpendOf(flaky, rates))),
    })
    expect(cost.avoided).toEqual({
      quarantinedTests: new Set(quarantined.map((row) => row.testIdentityId)).size,
      flakyOccurrences: sum(quarantined.map((row) => row.flaky)),
      peopleSpend: round(peopleSpendOf(sum(quarantined.map((row) => row.flaky)), rates)),
    })
    expect(cost.trend.map((day) => day.day.toISOString().slice(0, 10))).toEqual(
      [...new Set(window.map((row) => row.day.toISOString().slice(0, 10)))].sort(),
    )

    const byTest = new Map<string, Row[]>()
    for (const row of window) {
      byTest.set(row.testIdentityId, [...(byTest.get(row.testIdentityId) ?? []), row])
    }
    const expected = [...byTest.values()]
      .map((own) => {
        const testRerunMs = sum(own.map((row) => row.rerunMs))
        const testFlaky = sum(own.map((row) => row.flaky))
        return {
          testIdentityId: own[0]!.testIdentityId,
          rerunCount: sum(own.map((row) => row.rerunCount)),
          rerunMs: testRerunMs,
          flakyOccurrences: testFlaky,
          spend: round(ciSpendOf(testRerunMs, rates) + peopleSpendOf(testFlaky, rates)),
        }
      })
      .filter((test) => test.rerunCount > 0 || test.flakyOccurrences > 0)
      .sort(
        (a, b) =>
          b.spend - a.spend ||
          b.rerunMs - a.rerunMs ||
          (a.testIdentityId < b.testIdentityId ? -1 : 1),
      )
      .slice(0, 10)

    expect(
      cost.offenders.map(
        ({ testIdentityId, rerunCount, rerunMs: ms, flakyOccurrences, spend }) => ({
          testIdentityId,
          rerunCount,
          rerunMs: ms,
          flakyOccurrences,
          spend,
        }),
      ),
    ).toEqual(expected)
  })
})
