import type { PrismaClient } from '@flakemetry/db'

import { variantOf } from './params'

const dayString = (date: Date): string => date.toISOString().slice(0, 10)

const since = (days: number): Date => {
  const date = new Date(Date.now() - days * 24 * 60 * 60 * 1000)
  date.setUTCHours(0, 0, 0, 0)
  return date
}

const rateOf = (part: number, whole: number): number | null => (whole > 0 ? part / whole : null)

const averageOf = (sum: number, samples: number): number | null =>
  samples > 0 ? Math.round(sum / samples) : null

export interface SuiteDayPoint {
  day: string
  total: number
  ran: number
  failed: number
  flaky: number
  avgDurationMs: number | null
  durationSamples: number
}

export interface SuiteHealthRow {
  suite: string
  total: number
  ran: number
  failed: number
  flaky: number
  failRate: number
  avgDurationMs: number | null
  days: SuiteDayPoint[]
}

export const SUITE_REGRESSION = { minTotal: 20, minFailRate: 0.1, minDelta: 0.15 }

export const isSuiteRegressed = (
  days: readonly Pick<SuiteDayPoint, 'ran' | 'failed' | 'flaky'>[],
): boolean => {
  if (days.length < 2) return false
  const today = days[days.length - 1]!
  if (today.ran < SUITE_REGRESSION.minTotal) return false
  const prior = days.slice(0, -1).filter((day) => day.ran >= SUITE_REGRESSION.minTotal)
  if (prior.length === 0) return false
  const priorRan = prior.reduce((sum, day) => sum + day.ran, 0)
  const priorBad = prior.reduce((sum, day) => sum + day.failed + day.flaky, 0)
  const baseline = priorRan > 0 ? priorBad / priorRan : 0
  const rate = (today.failed + today.flaky) / today.ran
  return rate >= SUITE_REGRESSION.minFailRate && rate - baseline >= SUITE_REGRESSION.minDelta
}

export const SUITE_DURATION_REGRESSION = { minTotal: 20, minAvgMs: 500, minRatio: 1.3 }

export const isSuiteDurationRegressed = (
  days: readonly Pick<SuiteDayPoint, 'durationSamples' | 'avgDurationMs'>[],
): boolean => {
  if (days.length < 2) return false
  const today = days[days.length - 1]!
  if (today.avgDurationMs === null) return false
  if (today.durationSamples < SUITE_DURATION_REGRESSION.minTotal) return false
  const prior = days
    .slice(0, -1)
    .filter((day) => day.durationSamples >= SUITE_DURATION_REGRESSION.minTotal)
  if (prior.length === 0) return false
  const priorSamples = prior.reduce((sum, day) => sum + day.durationSamples, 0)
  const priorDuration = prior.reduce(
    (sum, day) => sum + (day.avgDurationMs ?? 0) * day.durationSamples,
    0,
  )
  const baseline = priorSamples > 0 ? priorDuration / priorSamples : 0
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
      durationSamples: true,
    },
  })

  const bySuite = new Map<
    string,
    SuiteHealthRow & { sumDuration: number; durationSamples: number }
  >()
  for (const row of rows) {
    const entry =
      bySuite.get(row.suite) ??
      ({
        suite: row.suite,
        total: 0,
        ran: 0,
        failed: 0,
        flaky: 0,
        failRate: 0,
        avgDurationMs: null,
        sumDuration: 0,
        durationSamples: 0,
        days: [],
      } satisfies SuiteHealthRow & { sumDuration: number; durationSamples: number })
    entry.total += row.total
    entry.ran += row.total - row.skipped
    entry.failed += row.failed
    entry.flaky += row.flaky
    entry.sumDuration += row.avgDurationMs * row.durationSamples
    entry.durationSamples += row.durationSamples
    entry.days.push({
      day: dayString(row.day),
      total: row.total,
      ran: row.total - row.skipped,
      failed: row.failed,
      flaky: row.flaky,
      avgDurationMs: row.durationSamples > 0 ? row.avgDurationMs : null,
      durationSamples: row.durationSamples,
    })
    bySuite.set(row.suite, entry)
  }

  return [...bySuite.values()]
    .map(({ sumDuration, durationSamples, ...suite }) => ({
      ...suite,
      failRate: rateOf(suite.failed + suite.flaky, suite.ran) ?? 0,
      avgDurationMs: averageOf(sumDuration, durationSamples),
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
  skipped: number
  passRate: number | null
  flakyRate: number | null
  failRate: number | null
  avgDurationMs: number | null
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
      skipped: bigint | null
      samples: bigint | null
      duration: bigint | null
    }[]
  >`
    SELECT sum(total)::bigint AS total,
           sum(passed)::bigint AS passed,
           sum(failed)::bigint AS failed,
           sum(flaky)::bigint AS flaky,
           sum(skipped)::bigint AS skipped,
           sum(duration_samples)::bigint AS samples,
           sum(avg_duration_ms::bigint * duration_samples)::bigint AS duration
    FROM daily_test_stats
    WHERE project_id = ${projectId}::uuid AND day >= ${dayString(since(days))}::date
  `

  const total = Number(row?.total ?? 0)
  const passed = Number(row?.passed ?? 0)
  const failed = Number(row?.failed ?? 0)
  const flaky = Number(row?.flaky ?? 0)
  const skipped = Number(row?.skipped ?? 0)
  const totalDurationMs = Number(row?.duration ?? 0)
  const ran = total - skipped

  return {
    totalExecutions: total,
    skipped,
    passRate: rateOf(passed, ran),
    flakyRate: rateOf(flaky, ran),
    failRate: rateOf(failed, ran),
    avgDurationMs: averageOf(totalDurationMs, Number(row?.samples ?? 0)),
    totalDurationMs,
  }
}

export interface DailyTrendPoint {
  day: string
  total: number
  passRate: number | null
  flakyRate: number | null
  avgDurationMs: number | null
}

export const getDailyTrend = async (
  prisma: PrismaClient,
  projectId: string,
  days = 14,
): Promise<DailyTrendPoint[]> => {
  const rows = await prisma.$queryRaw<
    {
      day: Date
      total: bigint
      passed: bigint
      flaky: bigint
      skipped: bigint
      samples: bigint
      duration: bigint
    }[]
  >`
    SELECT day,
           sum(total)::bigint AS total,
           sum(passed)::bigint AS passed,
           sum(flaky)::bigint AS flaky,
           sum(skipped)::bigint AS skipped,
           sum(duration_samples)::bigint AS samples,
           sum(avg_duration_ms::bigint * duration_samples)::bigint AS duration
    FROM daily_test_stats
    WHERE project_id = ${projectId}::uuid AND day >= ${dayString(since(days))}::date
    GROUP BY day
    ORDER BY day
  `

  return rows.map((row) => {
    const total = Number(row.total)
    const ran = total - Number(row.skipped)
    return {
      day: dayString(row.day),
      total,
      passRate: rateOf(Number(row.passed), ran),
      flakyRate: rateOf(Number(row.flaky), ran),
      avgDurationMs: averageOf(Number(row.duration), Number(row.samples)),
    }
  })
}

export interface LeaderboardTest {
  testIdentityId: string
  title: string
  variant: string | null
  suite: string
  filePath: string
  runs: number
  failedRuns: number
  failRate: number
  avgDurationMs: number
}

export interface Leaderboards {
  slowest: LeaderboardTest[]
  mostFailing: LeaderboardTest[]
  failingHooks: number
}

interface LeaderboardRow {
  board: 'slowest' | 'failing'
  test_identity_id: string
  title: string
  params: unknown
  suite: string
  file_path: string
  runs: bigint
  failed_runs: bigint
  avg_ms: bigint
  fail_rate: number
}

const HOOK_TITLE = '^"(before|after)( all| each)?" hook'
const MIN_RANKED_RUNS = 3

export const getTestLeaderboards = async (
  prisma: PrismaClient,
  projectId: string,
  days = 14,
  limit = 8,
): Promise<Leaderboards> => {
  const from = dayString(since(days))
  const [rows, hooks] = await Promise.all([
    prisma.$queryRaw<LeaderboardRow[]>`
    WITH per_test AS (
      SELECT test_identity_id,
             sum(first_attempt_runs)::bigint AS runs,
             sum(first_attempt_failed_runs)::bigint AS failed_runs,
             sum(duration_samples)::bigint AS samples,
             sum(avg_duration_ms::bigint * duration_samples)::bigint AS duration
      FROM daily_test_stats
      WHERE project_id = ${projectId}::uuid AND day >= ${from}::date
      GROUP BY test_identity_id
    ),
    measured AS (
      SELECT per_test.*,
             CASE WHEN samples > 0 THEN round(duration::numeric / samples)::bigint ELSE 0 END AS avg_ms,
             CASE WHEN runs > 0 THEN failed_runs::float8 / runs ELSE 0 END AS fail_rate
      FROM per_test
      JOIN test_identity identity ON identity.id = per_test.test_identity_id
      WHERE identity.title !~ ${HOOK_TITLE}
    ),
    boards AS (
      (SELECT 'slowest' AS board, measured.*,
              row_number() OVER (ORDER BY avg_ms DESC, test_identity_id) AS position
       FROM measured
       WHERE samples > 0
       ORDER BY avg_ms DESC, test_identity_id
       LIMIT ${limit})
      UNION ALL
      (SELECT 'failing' AS board, measured.*,
              row_number() OVER (
                ORDER BY runs >= ${MIN_RANKED_RUNS} DESC, fail_rate DESC, failed_runs DESC, test_identity_id
              ) AS position
       FROM measured
       WHERE failed_runs > 0
       ORDER BY runs >= ${MIN_RANKED_RUNS} DESC, fail_rate DESC, failed_runs DESC, test_identity_id
       LIMIT ${limit})
    )
    SELECT boards.board, boards.test_identity_id, identity.title, identity.params, identity.suite,
           identity.file_path, boards.runs, boards.failed_runs, boards.avg_ms, boards.fail_rate
    FROM boards
    JOIN test_identity identity ON identity.id = boards.test_identity_id
    ORDER BY boards.board, boards.position
  `,
    prisma.$queryRaw<{ count: bigint }[]>`
    SELECT count(DISTINCT stats.test_identity_id)::bigint AS count
    FROM daily_test_stats stats
    JOIN test_identity identity ON identity.id = stats.test_identity_id
    WHERE stats.project_id = ${projectId}::uuid AND stats.day >= ${from}::date
      AND stats.failed + stats.flaky > 0
      AND identity.title ~ ${HOOK_TITLE}
  `,
  ])

  const toTest = (row: LeaderboardRow): LeaderboardTest => ({
    testIdentityId: row.test_identity_id,
    title: row.title,
    variant: variantOf(row.params),
    suite: row.suite,
    filePath: row.file_path,
    runs: Number(row.runs),
    failedRuns: Number(row.failed_runs),
    failRate: Number(row.fail_rate),
    avgDurationMs: Number(row.avg_ms),
  })

  return {
    slowest: rows.filter((row) => row.board === 'slowest').map(toTest),
    mostFailing: rows.filter((row) => row.board === 'failing').map(toTest),
    failingHooks: Number(hooks[0]?.count ?? 0),
  }
}
