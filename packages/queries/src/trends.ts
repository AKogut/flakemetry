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
