import type { PrismaClient } from '@flakemetry/db'

const dayString = (date: Date): string => date.toISOString().slice(0, 10)

const since = (days: number): Date => {
  const date = new Date(Date.now() - days * 24 * 60 * 60 * 1000)
  date.setUTCHours(0, 0, 0, 0)
  return date
}

export interface SuiteDayPoint {
  day: string
  total: number
  failed: number
  flaky: number
  avgDurationMs: number
}

export interface SuiteHealthRow {
  suite: string
  total: number
  failed: number
  flaky: number
  failRate: number
  avgDurationMs: number
  days: SuiteDayPoint[]
}

export const getSuiteHealth = async (
  prisma: PrismaClient,
  projectId: string,
  days = 14,
): Promise<SuiteHealthRow[]> => {
  const rows = await prisma.suiteDaily.findMany({
    where: { projectId, day: { gte: since(days) } },
    orderBy: { day: 'asc' },
    select: {
      suite: true,
      day: true,
      total: true,
      passed: true,
      failed: true,
      flaky: true,
      skipped: true,
      avgDurationMs: true,
    },
  })

  const bySuite = new Map<string, SuiteHealthRow & { sumDuration: number }>()
  for (const row of rows) {
    const entry =
      bySuite.get(row.suite) ??
      ({
        suite: row.suite,
        total: 0,
        failed: 0,
        flaky: 0,
        failRate: 0,
        avgDurationMs: 0,
        sumDuration: 0,
        days: [],
      } satisfies SuiteHealthRow & { sumDuration: number })
    entry.total += row.total
    entry.failed += row.failed
    entry.flaky += row.flaky
    entry.sumDuration += row.avgDurationMs * row.total
    entry.days.push({
      day: dayString(row.day),
      total: row.total,
      failed: row.failed,
      flaky: row.flaky,
      avgDurationMs: row.avgDurationMs,
    })
    bySuite.set(row.suite, entry)
  }

  return [...bySuite.values()]
    .map(({ sumDuration, ...suite }) => ({
      ...suite,
      failRate: suite.total > 0 ? (suite.failed + suite.flaky) / suite.total : 0,
      avgDurationMs: suite.total > 0 ? Math.round(sumDuration / suite.total) : 0,
    }))
    .sort((a, b) => b.failRate - a.failRate || b.total - a.total)
}

export interface FlakyTrendPoint {
  day: string
  flakyCount: number
  quarantinedCount: number
  avgScore: number
}

export const getFlakyTrend = async (
  prisma: PrismaClient,
  projectId: string,
  days = 30,
): Promise<FlakyTrendPoint[]> => {
  const rows = await prisma.flakyTrends.findMany({
    where: { projectId, day: { gte: since(days) } },
    orderBy: { day: 'asc' },
    select: { day: true, flakyCount: true, quarantinedCount: true, avgScore: true },
  })

  return rows.map((row) => ({
    day: dayString(row.day),
    flakyCount: row.flakyCount,
    quarantinedCount: row.quarantinedCount,
    avgScore: row.avgScore,
  }))
}

export interface HealthKpis {
  totalExecutions: number
  passRate: number
  flakyRate: number
  failRate: number
  avgDurationMs: number
  totalDurationMs: number
}

export const getProjectHealthKpis = async (
  prisma: PrismaClient,
  projectId: string,
  days = 14,
): Promise<HealthKpis> => {
  const rows = await prisma.dailyTestStats.findMany({
    where: { projectId, day: { gte: since(days) } },
    select: { total: true, passed: true, failed: true, flaky: true, avgDurationMs: true },
  })

  let total = 0
  let passed = 0
  let failed = 0
  let flaky = 0
  let totalDurationMs = 0
  for (const row of rows) {
    total += row.total
    passed += row.passed
    failed += row.failed
    flaky += row.flaky
    totalDurationMs += row.avgDurationMs * row.total
  }

  return {
    totalExecutions: total,
    passRate: total > 0 ? passed / total : 0,
    flakyRate: total > 0 ? flaky / total : 0,
    failRate: total > 0 ? failed / total : 0,
    avgDurationMs: total > 0 ? Math.round(totalDurationMs / total) : 0,
    totalDurationMs,
  }
}

export interface DailyTrendPoint {
  day: string
  total: number
  passRate: number
  flakyRate: number
  avgDurationMs: number
}

export const getDailyTrend = async (
  prisma: PrismaClient,
  projectId: string,
  days = 14,
): Promise<DailyTrendPoint[]> => {
  const rows = await prisma.dailyTestStats.findMany({
    where: { projectId, day: { gte: since(days) } },
    select: { day: true, total: true, passed: true, flaky: true, avgDurationMs: true },
  })

  const byDay = new Map<
    string,
    { total: number; passed: number; flaky: number; sumDuration: number }
  >()
  for (const row of rows) {
    const key = dayString(row.day)
    const entry = byDay.get(key) ?? { total: 0, passed: 0, flaky: 0, sumDuration: 0 }
    entry.total += row.total
    entry.passed += row.passed
    entry.flaky += row.flaky
    entry.sumDuration += row.avgDurationMs * row.total
    byDay.set(key, entry)
  }

  return [...byDay.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([day, entry]) => ({
      day,
      total: entry.total,
      passRate: entry.total > 0 ? entry.passed / entry.total : 0,
      flakyRate: entry.total > 0 ? entry.flaky / entry.total : 0,
      avgDurationMs: entry.total > 0 ? Math.round(entry.sumDuration / entry.total) : 0,
    }))
}

export interface LeaderboardTest {
  testIdentityId: string
  title: string
  suite: string
  filePath: string
  total: number
  failed: number
  flaky: number
  failRate: number
  avgDurationMs: number
}

export interface Leaderboards {
  slowest: LeaderboardTest[]
  mostFailing: LeaderboardTest[]
}

export const getTestLeaderboards = async (
  prisma: PrismaClient,
  projectId: string,
  days = 14,
  limit = 8,
): Promise<Leaderboards> => {
  const rows = await prisma.dailyTestStats.findMany({
    where: { projectId, day: { gte: since(days) } },
    select: {
      testIdentityId: true,
      total: true,
      failed: true,
      flaky: true,
      avgDurationMs: true,
      identity: { select: { title: true, suite: true, filePath: true } },
    },
  })

  const byTest = new Map<string, LeaderboardTest & { sumDuration: number }>()
  for (const row of rows) {
    const entry =
      byTest.get(row.testIdentityId) ??
      ({
        testIdentityId: row.testIdentityId,
        title: row.identity.title,
        suite: row.identity.suite,
        filePath: row.identity.filePath,
        total: 0,
        failed: 0,
        flaky: 0,
        failRate: 0,
        avgDurationMs: 0,
        sumDuration: 0,
      } satisfies LeaderboardTest & { sumDuration: number })
    entry.total += row.total
    entry.failed += row.failed
    entry.flaky += row.flaky
    entry.sumDuration += row.avgDurationMs * row.total
    byTest.set(row.testIdentityId, entry)
  }

  const tests = [...byTest.values()].map(({ sumDuration, ...test }) => ({
    ...test,
    failRate: test.total > 0 ? (test.failed + test.flaky) / test.total : 0,
    avgDurationMs: test.total > 0 ? Math.round(sumDuration / test.total) : 0,
  }))

  return {
    slowest: [...tests].sort((a, b) => b.avgDurationMs - a.avgDurationMs).slice(0, limit),
    mostFailing: [...tests]
      .filter((test) => test.failed + test.flaky > 0)
      .sort((a, b) => b.failRate - a.failRate || b.failed - a.failed)
      .slice(0, limit),
  }
}
