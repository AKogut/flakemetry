import type { PrismaClient, TestStatus } from '@flakemetry/db'

export interface RollupContext {
  orgId: string
  projectId: string
}

export const pruneRawExecutions = async (
  prisma: PrismaClient,
  options: { olderThanDays: number; now?: Date },
): Promise<number> => {
  const now = options.now ?? new Date()
  const cutoff = new Date(now.getTime() - options.olderThanDays * 24 * 60 * 60 * 1000)
  const { count } = await prisma.testExecution.deleteMany({
    where: { startedAt: { lt: cutoff } },
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

const rollupDay = async (
  prisma: PrismaClient,
  ctx: RollupContext,
  day: Date,
  suites: readonly string[],
  testIdentityIds: readonly string[],
): Promise<void> => {
  const end = new Date(day.getTime() + DAY_MS)

  for (const testIdentityId of testIdentityIds) {
    const grouped = await prisma.testExecution.groupBy({
      by: ['status'],
      where: { testIdentityId, startedAt: { gte: day, lt: end } },
      _count: { _all: true },
      _sum: { durationMs: true },
    })
    const bucket = emptyBucket()
    for (const row of grouped) {
      addStatus(bucket, row.status, row._count._all, row._sum.durationMs ?? 0)
    }
    if (bucket.total === 0) {
      await prisma.dailyTestStats.deleteMany({ where: { testIdentityId, day } })
      continue
    }

    const data = {
      orgId: ctx.orgId,
      projectId: ctx.projectId,
      total: bucket.total,
      passed: bucket.passed,
      failed: bucket.failed,
      flaky: bucket.flaky,
      skipped: bucket.skipped,
      avgDurationMs: avg(bucket.sumDuration, bucket.total),
    }
    await prisma.dailyTestStats.upsert({
      where: { testIdentityId_day: { testIdentityId, day } },
      create: { testIdentityId, day, ...data },
      update: data,
    })
  }

  for (const suite of suites) {
    const grouped = await prisma.testExecution.groupBy({
      by: ['status'],
      where: {
        projectId: ctx.projectId,
        startedAt: { gte: day, lt: end },
        identity: { suite },
      },
      _count: { _all: true },
      _sum: { durationMs: true },
    })
    const bucket = emptyBucket()
    for (const row of grouped) {
      addStatus(bucket, row.status, row._count._all, row._sum.durationMs ?? 0)
    }
    if (bucket.total === 0) {
      await prisma.suiteDaily.deleteMany({ where: { projectId: ctx.projectId, suite, day } })
      continue
    }

    const data = {
      orgId: ctx.orgId,
      total: bucket.total,
      passed: bucket.passed,
      failed: bucket.failed,
      flaky: bucket.flaky,
      skipped: bucket.skipped,
      avgDurationMs: avg(bucket.sumDuration, bucket.total),
    }
    await prisma.suiteDaily.upsert({
      where: { projectId_suite_day: { projectId: ctx.projectId, suite, day } },
      create: { projectId: ctx.projectId, suite, day, ...data },
      update: data,
    })
  }

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
}
