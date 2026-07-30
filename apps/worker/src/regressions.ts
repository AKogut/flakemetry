import type { PrismaClient } from '@flakemetry/db'

const DAY_MS = 24 * 60 * 60 * 1000

export interface SuiteDayRow {
  suite: string
  day: string
  total: number
  failed: number
  flaky: number
  avgDurationMs?: number
}

export interface SuiteRegression {
  suite: string
  day: string
  failRate: number
  baselineFailRate: number
  total: number
}

export interface RegressionOptions {
  minTotal?: number
  minFailRate?: number
  minDelta?: number
}

const failRateOf = (row: SuiteDayRow): number =>
  row.total > 0 ? (row.failed + row.flaky) / row.total : 0

export const detectRegressions = (
  rows: readonly SuiteDayRow[],
  today: string,
  options: RegressionOptions = {},
): SuiteRegression[] => {
  const minTotal = options.minTotal ?? 20
  const minFailRate = options.minFailRate ?? 0.1
  const minDelta = options.minDelta ?? 0.15

  const bySuite = new Map<string, SuiteDayRow[]>()
  for (const row of rows) {
    const list = bySuite.get(row.suite) ?? []
    list.push(row)
    bySuite.set(row.suite, list)
  }

  const regressions: SuiteRegression[] = []
  for (const [suite, suiteRows] of bySuite) {
    const todayRow = suiteRows.find((row) => row.day === today)
    if (!todayRow || todayRow.total < minTotal) continue
    const prior = suiteRows.filter((row) => row.day < today && row.total >= minTotal)
    if (prior.length === 0) continue

    const priorTotal = prior.reduce((sum, row) => sum + row.total, 0)
    const priorBad = prior.reduce((sum, row) => sum + row.failed + row.flaky, 0)
    const baseline = priorTotal > 0 ? priorBad / priorTotal : 0
    const rate = failRateOf(todayRow)
    if (rate >= minFailRate && rate - baseline >= minDelta) {
      regressions.push({
        suite,
        day: today,
        failRate: rate,
        baselineFailRate: baseline,
        total: todayRow.total,
      })
    }
  }
  return regressions
}

export interface SuiteDurationRegression {
  suite: string
  day: string
  avgDurationMs: number
  baselineDurationMs: number
  total: number
}

export interface DurationRegressionOptions {
  minTotal?: number
  minAvgMs?: number
  minRatio?: number
}

export const detectDurationRegressions = (
  rows: readonly SuiteDayRow[],
  today: string,
  options: DurationRegressionOptions = {},
): SuiteDurationRegression[] => {
  const minTotal = options.minTotal ?? 20
  const minAvgMs = options.minAvgMs ?? 500
  const minRatio = options.minRatio ?? 1.3

  const bySuite = new Map<string, SuiteDayRow[]>()
  for (const row of rows) {
    const list = bySuite.get(row.suite) ?? []
    list.push(row)
    bySuite.set(row.suite, list)
  }

  const regressions: SuiteDurationRegression[] = []
  for (const [suite, suiteRows] of bySuite) {
    const todayRow = suiteRows.find((row) => row.day === today)
    if (!todayRow || todayRow.total < minTotal) continue
    const todayAvg = todayRow.avgDurationMs ?? 0
    const prior = suiteRows.filter((row) => row.day < today && row.total >= minTotal)
    if (prior.length === 0) continue

    const priorTotal = prior.reduce((sum, row) => sum + row.total, 0)
    const priorDuration = prior.reduce((sum, row) => sum + (row.avgDurationMs ?? 0) * row.total, 0)
    const baseline = priorTotal > 0 ? priorDuration / priorTotal : 0
    if (todayAvg >= minAvgMs && baseline > 0 && todayAvg >= baseline * minRatio) {
      regressions.push({
        suite,
        day: today,
        avgDurationMs: todayAvg,
        baselineDurationMs: baseline,
        total: todayRow.total,
      })
    }
  }
  return regressions
}

const dayString = (date: Date): string => date.toISOString().slice(0, 10)

const loadSuiteDays = async (
  prisma: PrismaClient,
  projectId: string,
  day: Date,
  windowDays: number,
): Promise<SuiteDayRow[]> => {
  const since = new Date(day.getTime() - windowDays * DAY_MS)
  const rows = await prisma.suiteDaily.findMany({
    where: { projectId, day: { gte: since, lte: day } },
    select: { suite: true, day: true, total: true, failed: true, flaky: true, avgDurationMs: true },
  })
  return rows.map((row) => ({
    suite: row.suite,
    day: dayString(row.day),
    total: row.total,
    failed: row.failed,
    flaky: row.flaky,
    avgDurationMs: row.avgDurationMs,
  }))
}

export const detectSuiteRegressions = async (
  prisma: PrismaClient,
  projectId: string,
  day: Date,
  options?: RegressionOptions & { windowDays?: number },
): Promise<SuiteRegression[]> => {
  const rows = await loadSuiteDays(prisma, projectId, day, options?.windowDays ?? 14)
  return detectRegressions(rows, dayString(day), options)
}

export const detectSuiteDurationRegressions = async (
  prisma: PrismaClient,
  projectId: string,
  day: Date,
  options?: DurationRegressionOptions & { windowDays?: number },
): Promise<SuiteDurationRegression[]> => {
  const rows = await loadSuiteDays(prisma, projectId, day, options?.windowDays ?? 14)
  return detectDurationRegressions(rows, dayString(day), options)
}
