import type { IngestRunBatch } from '@flakemetry/contracts'
import { PrismaClient } from '@flakemetry/db'
import {
  getDailyTrend,
  getFlakyTrend,
  getProjectHealthKpis,
  getSuiteHealth,
  getTestLeaderboards,
} from '@flakemetry/queries'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'

import { processJob } from '../processor'
import { pruneRawExecutions } from '../rollups'

const hasDb = Boolean(process.env.DATABASE_URL)
const prisma = new PrismaClient()

const NOW = new Date('2026-07-16T12:00:00Z')

const seedProject = async () => {
  const org = await prisma.org.create({ data: { name: 'Acme', slug: `acme-${Date.now()}` } })
  const project = await prisma.project.create({ data: { orgId: org.id, name: 'Web', slug: 'web' } })
  return { orgId: org.id, projectId: project.id }
}

const batch = (over: Partial<IngestRunBatch> = {}): IngestRunBatch => ({
  contractVersion: '0.1.0',
  idempotencyKey: 'run-roll-1',
  resource: { ciProvider: 'github_actions', commitSha: 'abc1234', branch: 'main', trigger: 'push' },
  run: { status: 'failed', startedAt: new Date('2026-07-16T10:00:00Z') },
  executions: [
    {
      filePath: 'e2e/login.spec.ts',
      suite: 'auth',
      title: 'logs in',
      status: 'fail',
      attempt: 1,
      startedAt: new Date('2026-07-16T10:00:01Z'),
      durationMs: 1800,
      error: { message: 'Timeout 30000ms exceeded' },
    },
    {
      filePath: 'e2e/login.spec.ts',
      suite: 'auth',
      title: 'logs in',
      status: 'flaky',
      attempt: 2,
      retryOfIndex: 0,
      startedAt: new Date('2026-07-16T10:00:03Z'),
      durationMs: 1400,
    },
  ],
  ...over,
})

describe.skipIf(!hasDb)('trend rollups', () => {
  beforeEach(async () => {
    await prisma.flakyScore.deleteMany()
    await prisma.testExecution.deleteMany()
    await prisma.testIdentity.deleteMany()
    await prisma.run.deleteMany()
    await prisma.project.deleteMany()
    await prisma.org.deleteMany()
  })

  afterAll(async () => {
    await prisma.$disconnect()
  })

  it('materializes daily test, suite, and flaky-trend rollups on ingest', async () => {
    const ctx = { ...(await seedProject()), now: NOW }
    await processJob(prisma, batch(), ctx)

    const daily = await prisma.dailyTestStats.findFirstOrThrow()
    expect(daily.total).toBe(2)
    expect(daily.failed).toBe(1)
    expect(daily.flaky).toBe(1)
    expect(daily.avgDurationMs).toBe(1600)

    const suite = await prisma.suiteDaily.findFirstOrThrow({ where: { suite: 'auth' } })
    expect(suite.total).toBe(2)
    expect(suite.failed).toBe(1)
    expect(suite.avgDurationMs).toBe(1600)

    // Only the second attempt is waste. The first would have run either way, so counting
    // the whole 3200ms would inflate every cost figure built on this column.
    expect(daily.rerunCount).toBe(1)
    expect(daily.rerunMs).toBe(1400)
    expect(suite.rerunCount).toBe(1)
    expect(suite.rerunMs).toBe(1400)

    const trend = await prisma.flakyTrends.findFirstOrThrow()
    expect(trend.flakyCount).toBeGreaterThanOrEqual(0)
  })

  it('serves the rollups through the query api', async () => {
    const ctx = { ...(await seedProject()), now: NOW }
    await processJob(prisma, batch(), ctx)

    const health = await getSuiteHealth(prisma, ctx.projectId, 3650)
    expect(health).toHaveLength(1)
    expect(health[0]?.suite).toBe('auth')
    expect(health[0]?.failRate).toBe(1)

    const flakyTrend = await getFlakyTrend(prisma, ctx.projectId, 3650)
    expect(flakyTrend).toHaveLength(1)
    expect(flakyTrend[0]?.day).toBe('2026-07-16')
  })

  it('serves suite-health KPIs, daily trend, and leaderboards from rollups', async () => {
    const ctx = { ...(await seedProject()), now: NOW }
    await processJob(prisma, batch(), ctx)

    const kpis = await getProjectHealthKpis(prisma, ctx.projectId, 3650)
    expect(kpis.totalExecutions).toBe(2)
    expect(kpis.passRate).toBe(0)
    expect(kpis.flakyRate).toBe(0.5)
    expect(kpis.avgDurationMs).toBe(1600)

    const daily = await getDailyTrend(prisma, ctx.projectId, 3650)
    expect(daily).toHaveLength(1)
    expect(daily[0]?.flakyRate).toBe(0.5)

    const leaderboards = await getTestLeaderboards(prisma, ctx.projectId, 3650)
    expect(leaderboards.slowest[0]?.avgDurationMs).toBe(1600)
    expect(leaderboards.mostFailing[0]?.failRate).toBe(1)
  })

  it('rolls up each UTC day a midnight-straddling run touches', async () => {
    const ctx = { ...(await seedProject()), now: NOW }
    await processJob(
      prisma,
      batch({
        idempotencyKey: 'run-straddle',
        run: { status: 'failed', startedAt: new Date('2026-07-16T23:59:00Z') },
        executions: [
          {
            filePath: 'e2e/login.spec.ts',
            suite: 'auth',
            title: 'logs in',
            status: 'fail',
            attempt: 1,
            startedAt: new Date('2026-07-16T23:59:30Z'),
            durationMs: 1000,
            error: { message: 'Timeout 30000ms exceeded' },
          },
          {
            filePath: 'e2e/login.spec.ts',
            suite: 'auth',
            title: 'logs in',
            status: 'flaky',
            attempt: 2,
            retryOfIndex: 0,
            startedAt: new Date('2026-07-17T00:00:30Z'),
            durationMs: 1200,
          },
        ],
      }),
      ctx,
    )

    const daily = await prisma.dailyTestStats.findMany({ orderBy: { day: 'asc' } })
    expect(daily).toHaveLength(2)
    expect(daily[0]?.day.toISOString().slice(0, 10)).toBe('2026-07-16')
    expect(daily[0]?.total).toBe(1)
    expect(daily[0]?.failed).toBe(1)
    expect(daily[0]?.avgDurationMs).toBe(1000)
    expect(daily[1]?.day.toISOString().slice(0, 10)).toBe('2026-07-17')
    expect(daily[1]?.total).toBe(1)
    expect(daily[1]?.flaky).toBe(1)
    expect(daily[1]?.avgDurationMs).toBe(1200)

    const suite = await prisma.suiteDaily.findMany({ orderBy: { day: 'asc' } })
    expect(suite).toHaveLength(2)
    expect(suite[0]?.total).toBe(1)
    expect(suite[1]?.total).toBe(1)
  })

  it('stays idempotent when the same run is re-delivered', async () => {
    const ctx = { ...(await seedProject()), now: NOW }
    await processJob(prisma, batch(), ctx)
    await processJob(prisma, batch(), ctx)

    const daily = await prisma.dailyTestStats.findMany()
    expect(daily).toHaveLength(1)
    expect(daily[0]?.total).toBe(2)

    const suite = await prisma.suiteDaily.findMany()
    expect(suite).toHaveLength(1)
    expect(suite[0]?.total).toBe(2)
  })

  it('prunes raw executions past the cutoff while rollups persist', async () => {
    const ctx = { ...(await seedProject()), now: NOW }
    await processJob(prisma, batch(), ctx)

    const pruned = await pruneRawExecutions(prisma, {
      olderThanDays: 7,
      now: new Date('2026-07-30T00:00:00Z'),
    })

    expect(pruned).toBe(2)
    expect(await prisma.testExecution.count()).toBe(0)
    expect(await prisma.dailyTestStats.count()).toBe(1)
    expect(await prisma.suiteDaily.count()).toBe(1)
  })
})
