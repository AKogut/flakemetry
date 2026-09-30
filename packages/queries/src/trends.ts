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

export const SUITE_REGRESSION = { minTotal: 20, minFailRate: 0.1, minDelta: 0.15 }

export const isSuiteRegressed = (
  days: readonly Pick<SuiteDayPoint, 'total' | 'failed' | 'flaky'>[],
): boolean => {
  if (days.length < 2) return false
  const today = days[days.length - 1]!
  if (today.total < SUITE_REGRESSION.minTotal) return false
  const prior = days.slice(0, -1).filter((day) => day.total >= SUITE_REGRESSION.minTotal)
  if (prior.length === 0) return false
  const priorTotal = prior.reduce((sum, day) => sum + day.total, 0)
  const priorBad = prior.reduce((sum, day) => sum + day.failed + day.flaky, 0)
  const baseline = priorTotal > 0 ? priorBad / priorTotal : 0
  const rate = (today.failed + today.flaky) / today.total
  return rate >= SUITE_REGRESSION.minFailRate && rate - baseline >= SUITE_REGRESSION.minDelta
}

export const SUITE_DURATION_REGRESSION = { minTotal: 20, minAvgMs: 500, minRatio: 1.3 }

export const isSuiteDurationRegressed = (
  days: readonly Pick<SuiteDayPoint, 'total' | 'avgDurationMs'>[],
): boolean => {
  if (days.length < 2) return false
  const today = days[days.length - 1]!
  if (today.total < SUITE_DURATION_REGRESSION.minTotal) return false
  const prior = days.slice(0, -1).filter((day) => day.total >= SUITE_DURATION_REGRESSION.minTotal)
  if (prior.length === 0) return false
  const priorTotal = prior.reduce((sum, day) => sum + day.total, 0)
  const priorDuration = prior.reduce((sum, day) => sum + day.avgDurationMs * day.total, 0)
  const baseline = priorTotal > 0 ? priorDuration / priorTotal : 0
  return (
    today.avgDurationMs >= SUITE_DURATION_REGRESSION.minAvgMs &&
    baseline > 0 &&
    today.avgDurationMs >= baseline * SUITE_DURATION_REGRESSION.minRatio
  )
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
  const [row] = await prisma.$queryRaw<
    {
      total: bigint | null
      passed: bigint | null
      failed: bigint | null
      flaky: bigint | null
      duration: bigint | null
    }[]
  >`
    SELECT sum(total)::bigint AS total,
           sum(passed)::bigint AS passed,
           sum(failed)::bigint AS failed,
           sum(flaky)::bigint AS flaky,
           sum(avg_duration_ms::bigint * total)::bigint AS duration
    FROM daily_test_stats
    WHERE project_id = ${projectId}::uuid AND day >= ${dayString(since(days))}::date
  `

  const total = Number(row?.total ?? 0)
  const passed = Number(row?.passed ?? 0)
  const failed = Number(row?.failed ?? 0)
  const flaky = Number(row?.flaky ?? 0)
  const totalDurationMs = Number(row?.duration ?? 0)

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
  const rows = await prisma.$queryRaw<
    { day: Date; total: bigint; passed: bigint; flaky: bigint; duration: bigint }[]
  >`
    SELECT day,
           sum(total)::bigint AS total,
           sum(passed)::bigint AS passed,
           sum(flaky)::bigint AS flaky,
           sum(avg_duration_ms::bigint * total)::bigint AS duration
    FROM daily_test_stats
    WHERE project_id = ${projectId}::uuid AND day >= ${dayString(since(days))}::date
    GROUP BY day
    ORDER BY day
  `

  return rows.map((row) => {
    const total = Number(row.total)
    return {
      day: dayString(row.day),
      total,
      passRate: total > 0 ? Number(row.passed) / total : 0,
      flakyRate: total > 0 ? Number(row.flaky) / total : 0,
      avgDurationMs: total > 0 ? Math.round(Number(row.duration) / total) : 0,
    }
  })
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

interface LeaderboardRow {
  board: 'slowest' | 'failing'
  test_identity_id: string
  title: string
  suite: string
  file_path: string
  total: bigint
  failed: bigint
  flaky: bigint
  avg_ms: bigint
  fail_rate: number
}

export const getTestLeaderboards = async (
  prisma: PrismaClient,
  projectId: string,
  days = 14,
  limit = 8,
): Promise<Leaderboards> => {
  const rows = await prisma.$queryRaw<LeaderboardRow[]>`
    WITH per_test AS (
      SELECT test_identity_id,
             sum(total)::bigint AS total,
             sum(failed)::bigint AS failed,
             sum(flaky)::bigint AS flaky,
             sum(avg_duration_ms::bigint * total)::bigint AS duration
      FROM daily_test_stats
      WHERE project_id = ${projectId}::uuid AND day >= ${dayString(since(days))}::date
      GROUP BY test_identity_id
    ),
    measured AS (
      SELECT *,
             CASE WHEN total > 0 THEN round(duration::numeric / total)::bigint ELSE 0 END AS avg_ms,
             CASE WHEN total > 0 THEN (failed + flaky)::float8 / total ELSE 0 END AS fail_rate
      FROM per_test
    ),
    boards AS (
      (SELECT 'slowest' AS board, measured.*,
              row_number() OVER (ORDER BY avg_ms DESC, test_identity_id) AS position
       FROM measured
       ORDER BY avg_ms DESC, test_identity_id
       LIMIT ${limit})
      UNION ALL
      (SELECT 'failing' AS board, measured.*,
              row_number() OVER (ORDER BY fail_rate DESC, failed DESC, test_identity_id) AS position
       FROM measured
       WHERE failed + flaky > 0
       ORDER BY fail_rate DESC, failed DESC, test_identity_id
       LIMIT ${limit})
    )
    SELECT boards.board, boards.test_identity_id, identity.title, identity.suite,
           identity.file_path, boards.total, boards.failed, boards.flaky, boards.avg_ms,
           boards.fail_rate
    FROM boards
    JOIN test_identity identity ON identity.id = boards.test_identity_id
    ORDER BY boards.board, boards.position
  `

  const toTest = (row: LeaderboardRow): LeaderboardTest => ({
    testIdentityId: row.test_identity_id,
    title: row.title,
    suite: row.suite,
    filePath: row.file_path,
    total: Number(row.total),
    failed: Number(row.failed),
    flaky: Number(row.flaky),
    failRate: Number(row.fail_rate),
    avgDurationMs: Number(row.avg_ms),
  })

  return {
    slowest: rows.filter((row) => row.board === 'slowest').map(toTest),
    mostFailing: rows.filter((row) => row.board === 'failing').map(toTest),
  }
}
