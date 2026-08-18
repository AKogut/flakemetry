import type { PrismaClient, TestStatus } from '@flakemetry/db'

export interface RollupContext {
  orgId: string
  projectId: string
}

export const pruneRawExecutions = async (
  prisma: PrismaClient,
  options: { olderThanDays: number; projectId?: string; now?: Date },
): Promise<number> => {
  const now = options.now ?? new Date()
  const cutoff = new Date(now.getTime() - options.olderThanDays * 24 * 60 * 60 * 1000)
  const { count } = await prisma.testExecution.deleteMany({
    where: {
      startedAt: { lt: cutoff },
      ...(options.projectId ? { projectId: options.projectId } : {}),
    },
  })
  return count
}

const dayStart = (date: Date): Date => {
  const day = new Date(date)
  day.setUTCHours(0, 0, 0, 0)
  return day
}

interface Bucket {
  total: number
  passed: number
  failed: number
  flaky: number
  skipped: number
  sumDuration: number
}

const emptyBucket = (): Bucket => ({
  total: 0,
  passed: 0,
  failed: 0,
  flaky: 0,
  skipped: 0,
  sumDuration: 0,
})

const addStatus = (
  bucket: Bucket,
  status: TestStatus,
  count: number,
  sumDuration: number,
): void => {
  bucket.total += count
  bucket.sumDuration += sumDuration
  if (status === 'pass') bucket.passed += count
  else if (status === 'fail') bucket.failed += count
  else if (status === 'flaky') bucket.flaky += count
  else if (status === 'skip') bucket.skipped += count
}

const avg = (sum: number, total: number): number => (total > 0 ? Math.round(sum / total) : 0)

const DAY_MS = 24 * 60 * 60 * 1000

const distinctDays = (dates: readonly Date[]): Date[] => {
  const seen = new Map<number, Date>()
  for (const date of dates) {
    const start = dayStart(date)
    seen.set(start.getTime(), start)
  }
  return [...seen.values()].sort((a, b) => a.getTime() - b.getTime())
}

interface StatusRow {
  key: string
  status: TestStatus
  count: bigint
  duration: bigint | null
}

interface RerunRow {
  key: string
  count: bigint
  duration: bigint | null
}

const bucketsFrom = (rows: readonly StatusRow[]): Map<string, Bucket> => {
  const byKey = new Map<string, Bucket>()
  for (const row of rows) {
    const bucket = byKey.get(row.key) ?? emptyBucket()
    addStatus(bucket, row.status, Number(row.count), Number(row.duration ?? 0))
    byKey.set(row.key, bucket)
  }
  return byKey
}

const rerunsFrom = (rows: readonly RerunRow[]): Map<string, { count: number; ms: number }> =>
  new Map(rows.map((row) => [row.key, { count: Number(row.count), ms: Number(row.duration ?? 0) }]))

/**
 * Every rollup for the day in four aggregates and two upserts, rather than two queries per
 * test and two per suite. The counts are identical — the grouping simply moved from a loop
 * in Node into the GROUP BY that was always going to do it better.
 */
const rollupDay = async (
  prisma: PrismaClient,
  ctx: RollupContext,
  day: Date,
  suites: readonly string[],
  testIdentityIds: readonly string[],
): Promise<void> => {
  const end = new Date(day.getTime() + DAY_MS)
  const ids = [...testIdentityIds]
  const suiteNames = [...suites]

  const [identityStatuses, identityReruns, suiteStatuses, suiteReruns] = await Promise.all([
    prisma.$queryRaw<StatusRow[]>`
      SELECT test_identity_id::text AS key, status::text AS status,
             count(*) AS count, sum(duration_ms) AS duration
      FROM test_execution
      WHERE project_id = ${ctx.projectId}::uuid
        AND started_at >= ${day} AND started_at < ${end}
        AND test_identity_id = ANY(${ids}::uuid[])
      GROUP BY 1, 2
    `,
    prisma.$queryRaw<RerunRow[]>`
      SELECT test_identity_id::text AS key, count(*) AS count, sum(duration_ms) AS duration
      FROM test_execution
      WHERE project_id = ${ctx.projectId}::uuid
        AND started_at >= ${day} AND started_at < ${end}
        AND attempt > 1
        AND test_identity_id = ANY(${ids}::uuid[])
      GROUP BY 1
    `,
    // Scoped by suite rather than summed from the identities above: those are only the
    // tests this run touched, while a suite rollup has to cover the whole suite.
    prisma.$queryRaw<StatusRow[]>`
      SELECT i.suite AS key, e.status::text AS status,
             count(*) AS count, sum(e.duration_ms) AS duration
      FROM test_execution e
      JOIN test_identity i ON i.id = e.test_identity_id
      WHERE e.project_id = ${ctx.projectId}::uuid
        AND e.started_at >= ${day} AND e.started_at < ${end}
        AND i.suite = ANY(${suiteNames}::text[])
      GROUP BY 1, 2
    `,
    prisma.$queryRaw<RerunRow[]>`
      SELECT i.suite AS key, count(*) AS count, sum(e.duration_ms) AS duration
      FROM test_execution e
      JOIN test_identity i ON i.id = e.test_identity_id
      WHERE e.project_id = ${ctx.projectId}::uuid
        AND e.started_at >= ${day} AND e.started_at < ${end}
        AND e.attempt > 1
        AND i.suite = ANY(${suiteNames}::text[])
      GROUP BY 1
    `,
  ])

  const identityBuckets = bucketsFrom(identityStatuses)
  const identityRerun = rerunsFrom(identityReruns)
  const suiteBuckets = bucketsFrom(suiteStatuses)
  const suiteRerun = rerunsFrom(suiteReruns)

  const identityRows = ids
    .filter((id) => (identityBuckets.get(id)?.total ?? 0) > 0)
    .map((id) => {
      const bucket = identityBuckets.get(id) as Bucket
      return {
        testIdentityId: id,
        orgId: ctx.orgId,
        projectId: ctx.projectId,
        total: bucket.total,
        passed: bucket.passed,
        failed: bucket.failed,
        flaky: bucket.flaky,
        skipped: bucket.skipped,
        avgDurationMs: avg(bucket.sumDuration, bucket.total),
        rerunCount: identityRerun.get(id)?.count ?? 0,
        rerunMs: identityRerun.get(id)?.ms ?? 0,
      }
    })
  const identityEmpties = ids.filter((id) => (identityBuckets.get(id)?.total ?? 0) === 0)

  const suiteRows = suiteNames
    .filter((suite) => (suiteBuckets.get(suite)?.total ?? 0) > 0)
    .map((suite) => {
      const bucket = suiteBuckets.get(suite) as Bucket
      return {
        suite,
        orgId: ctx.orgId,
        projectId: ctx.projectId,
        total: bucket.total,
        passed: bucket.passed,
        failed: bucket.failed,
        flaky: bucket.flaky,
        skipped: bucket.skipped,
        avgDurationMs: avg(bucket.sumDuration, bucket.total),
        rerunCount: suiteRerun.get(suite)?.count ?? 0,
        rerunMs: suiteRerun.get(suite)?.ms ?? 0,
      }
    })
  const suiteEmpties = suiteNames.filter((suite) => (suiteBuckets.get(suite)?.total ?? 0) === 0)

  if (identityEmpties.length > 0) {
    await prisma.dailyTestStats.deleteMany({
      where: { testIdentityId: { in: identityEmpties }, day },
    })
  }
  if (suiteEmpties.length > 0) {
    await prisma.suiteDaily.deleteMany({
      where: { projectId: ctx.projectId, suite: { in: suiteEmpties }, day },
    })
  }

  if (identityRows.length > 0) {
    await prisma.$executeRaw`
      INSERT INTO daily_test_stats (
        test_identity_id, org_id, project_id, day, total, passed, failed, flaky, skipped,
        avg_duration_ms, rerun_count, rerun_ms, updated_at
      )
      SELECT (row->>'testIdentityId')::uuid, (row->>'orgId')::uuid, (row->>'projectId')::uuid,
             ${day}::date, (row->>'total')::int, (row->>'passed')::int, (row->>'failed')::int,
             (row->>'flaky')::int, (row->>'skipped')::int, (row->>'avgDurationMs')::int,
             (row->>'rerunCount')::int, (row->>'rerunMs')::int, now()
      FROM jsonb_array_elements(${JSON.stringify(identityRows)}::jsonb) AS row
      ON CONFLICT (test_identity_id, day) DO UPDATE SET
        total = EXCLUDED.total, passed = EXCLUDED.passed, failed = EXCLUDED.failed,
        flaky = EXCLUDED.flaky, skipped = EXCLUDED.skipped,
        avg_duration_ms = EXCLUDED.avg_duration_ms, rerun_count = EXCLUDED.rerun_count,
        rerun_ms = EXCLUDED.rerun_ms, updated_at = now()
    `
  }

  if (suiteRows.length > 0) {
    await prisma.$executeRaw`
      INSERT INTO suite_daily (
        project_id, org_id, suite, day, total, passed, failed, flaky, skipped,
        avg_duration_ms, rerun_count, rerun_ms, updated_at
      )
      SELECT (row->>'projectId')::uuid, (row->>'orgId')::uuid, row->>'suite',
             ${day}::date, (row->>'total')::int, (row->>'passed')::int, (row->>'failed')::int,
             (row->>'flaky')::int, (row->>'skipped')::int, (row->>'avgDurationMs')::int,
             (row->>'rerunCount')::int, (row->>'rerunMs')::int, now()
      FROM jsonb_array_elements(${JSON.stringify(suiteRows)}::jsonb) AS row
      ON CONFLICT (project_id, suite, day) DO UPDATE SET
        total = EXCLUDED.total, passed = EXCLUDED.passed, failed = EXCLUDED.failed,
        flaky = EXCLUDED.flaky, skipped = EXCLUDED.skipped,
        avg_duration_ms = EXCLUDED.avg_duration_ms, rerun_count = EXCLUDED.rerun_count,
        rerun_ms = EXCLUDED.rerun_ms, updated_at = now()
    `
  }
}

const writeFlakyTrend = async (
  prisma: PrismaClient,
  ctx: RollupContext,
  day: Date,
): Promise<void> => {
  const [aggregate, flakyCount, quarantinedCount] = await Promise.all([
    prisma.flakyScore.aggregate({ where: { projectId: ctx.projectId }, _avg: { score: true } }),
    prisma.flakyScore.count({ where: { projectId: ctx.projectId, quarantineCandidate: true } }),
    prisma.testIdentity.count({ where: { projectId: ctx.projectId, quarantined: true } }),
  ])

  const trend = {
    orgId: ctx.orgId,
    flakyCount,
    quarantinedCount,
    avgScore: aggregate._avg.score ?? 0,
  }
  await prisma.flakyTrends.upsert({
    where: { projectId_day: { projectId: ctx.projectId, day } },
    create: { projectId: ctx.projectId, day, ...trend },
    update: trend,
  })
}

export const updateRollups = async (
  prisma: PrismaClient,
  ctx: RollupContext,
  executionDays: readonly Date[],
  testIdentityIds: readonly string[],
  now: Date = new Date(),
): Promise<void> => {
  if (testIdentityIds.length === 0) return
  const days = distinctDays(executionDays)
  if (days.length === 0) return

  const identities = await prisma.testIdentity.findMany({
    where: { id: { in: [...testIdentityIds] } },
    select: { id: true, suite: true },
  })
  const suites = [...new Set(identities.map((identity) => identity.suite))]
  const identityIds = identities.map((identity) => identity.id)

  for (const day of days) {
    await rollupDay(prisma, ctx, day, suites, identityIds)
  }

  await writeFlakyTrend(prisma, ctx, dayStart(now))
}
