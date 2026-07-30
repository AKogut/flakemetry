import type { PrismaClient } from '@flakemetry/db'

const DAY_MS = 24 * 60 * 60 * 1000

export interface SuiteDayRow {
  suite: string
  day: string
  total: number
  failed: number
  flaky: number
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

const dayString = (date: Date): string => date.toISOString().slice(0, 10)

export const detectSuiteRegressions = async (
  prisma: PrismaClient,
  projectId: string,
  day: Date,
  options?: RegressionOptions & { windowDays?: number },
): Promise<SuiteRegression[]> => {
  const windowDays = options?.windowDays ?? 14
  const since = new Date(day.getTime() - windowDays * DAY_MS)
  const rows = await prisma.suiteDaily.findMany({
    where: { projectId, day: { gte: since, lte: day } },
    select: { suite: true, day: true, total: true, failed: true, flaky: true },
  })
  return detectRegressions(
    rows.map((row) => ({
      suite: row.suite,
      day: dayString(row.day),
      total: row.total,
      failed: row.failed,
      flaky: row.flaky,
    })),
    dayString(day),
    options,
  )
}
