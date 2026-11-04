import type { IngestRunBatch } from '@flakemetry/contracts'
import { createPrismaClient } from '@flakemetry/db'
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
const prisma = createPrismaClient()

const NOW = new Date('2026-07-16T12:00:00Z')

const seedProject = async () => {
  const org = await prisma.org.create({ data: { name: 'Acme', slug: `acme-${Date.now()}` } })
  const project = await prisma.project.create({ data: { orgId: org.id, name: 'Web', slug: 'web' } })
  return { orgId: org.id, projectId: project.id }
}

const execution = (
  title: string,
  status: 'pass' | 'fail' | 'flaky' | 'skip',
  durationMs: number,
  over: Partial<IngestRunBatch['executions'][number]> = {},
): IngestRunBatch['executions'][number] => ({
  filePath: 'e2e/login.spec.ts',
  suite: 'auth',
  title,
  status,
  attempt: 1,
  startedAt: new Date('2026-07-16T10:00:01Z'),
  durationMs,
  ...(status === 'fail' ? { error: { message: 'Timeout 30000ms exceeded' } } : {}),
  ...over,
})

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

  it('leaves skipped tests out of every rate', async () => {
    const ctx = { ...(await seedProject()), now: NOW }
    await processJob(
      prisma,
      batch({
        run: { status: 'passed', startedAt: new Date('2026-07-16T10:00:00Z') },
        executions: [
          execution('one', 'pass', 100),
          execution('two', 'pass', 100),
          execution('three', 'skip', 0),
        ],
      }),
      ctx,
    )

    const kpis = await getProjectHealthKpis(prisma, ctx.projectId, 3650)
    expect(kpis.totalExecutions).toBe(3)
    expect(kpis.skipped).toBe(1)
    expect(kpis.passRate).toBe(1)
    expect(kpis.failRate).toBe(0)

    const daily = await getDailyTrend(prisma, ctx.projectId, 3650)
    expect(daily[0]?.passRate).toBe(1)

    const suites = await getSuiteHealth(prisma, ctx.projectId, 3650)
    expect(suites[0]?.total).toBe(3)
    expect(suites[0]?.ran).toBe(2)
    expect(suites[0]?.failRate).toBe(0)
  })

  it('has no rate when every test was skipped', async () => {
    const ctx = { ...(await seedProject()), now: NOW }
    await processJob(
      prisma,
      batch({
        run: { status: 'passed', startedAt: new Date('2026-07-16T10:00:00Z') },
        executions: [execution('one', 'skip', 0)],
      }),
      ctx,
    )

    const kpis = await getProjectHealthKpis(prisma, ctx.projectId, 3650)
    expect(kpis.passRate).toBeNull()
    expect(kpis.flakyRate).toBeNull()
    expect(kpis.avgDurationMs).toBeNull()

    const daily = await getDailyTrend(prisma, ctx.projectId, 3650)
    expect(daily[0]?.passRate).toBeNull()
    expect(daily[0]?.avgDurationMs).toBeNull()
  })

  it('keeps a measured 0ms and leaves out a run that recorded no durations', async () => {
    const ctx = { ...(await seedProject()), now: NOW }
    await processJob(
      prisma,
      batch({
        idempotencyKey: 'measured',
        run: { status: 'passed', startedAt: new Date('2026-07-16T10:00:00Z') },
        executions: [
          execution('slow', 'pass', 90),
          execution('instant', 'pass', 0),
          execution('ignored', 'skip', 0),
        ],
      }),
      ctx,
    )
    await processJob(
      prisma,
      batch({
        idempotencyKey: 'reconstructed',
        run: { status: 'passed', startedAt: new Date('2026-07-16T11:00:00Z') },
        executions: [execution('slow', 'pass', 0), execution('instant', 'pass', 0)],
      }),
      ctx,
    )

    const suite = await prisma.suiteDaily.findFirstOrThrow({ where: { suite: 'auth' } })
    expect(suite.total).toBe(5)
    expect(suite.durationSamples).toBe(2)
    expect(suite.avgDurationMs).toBe(45)

    const kpis = await getProjectHealthKpis(prisma, ctx.projectId, 3650)
    expect(kpis.avgDurationMs).toBe(45)

    const { slowest } = await getTestLeaderboards(prisma, ctx.projectId, 3650)
    expect(slowest.map((test) => [test.title, test.avgDurationMs])).toEqual([
      ['slow', 90],
      ['instant', 0],
    ])
  })

  it('reports no duration for a day whose runs recorded none', async () => {
    const ctx = { ...(await seedProject()), now: NOW }
    await processJob(
      prisma,
      batch({
        idempotencyKey: 'reconstructed',
        run: { status: 'failed', startedAt: new Date('2026-07-15T10:00:00Z') },
        executions: [
          execution('one', 'pass', 0, { startedAt: new Date('2026-07-15T10:00:01Z') }),
          execution('two', 'fail', 0, { startedAt: new Date('2026-07-15T10:00:01Z') }),
        ],
      }),
      ctx,
    )
    await processJob(
      prisma,
      batch({
        idempotencyKey: 'measured',
        run: { status: 'passed', startedAt: new Date('2026-07-16T10:00:00Z') },
        executions: [execution('one', 'pass', 30), execution('two', 'pass', 10)],
      }),
      ctx,
    )

    const daily = await getDailyTrend(prisma, ctx.projectId, 3650)
    expect(daily.map((point) => point.avgDurationMs)).toEqual([null, 20])

    const [suite] = await getSuiteHealth(prisma, ctx.projectId, 3650)
    expect(suite?.avgDurationMs).toBe(20)
    expect(suite?.days.map((day) => day.avgDurationMs)).toEqual([null, 20])

    const kpis = await getProjectHealthKpis(prisma, ctx.projectId, 3650)
    expect(kpis.avgDurationMs).toBe(20)
  })

  it('rates a failing test per run on first attempts', async () => {
    const ctx = { ...(await seedProject()), now: NOW }
    await processJob(prisma, batch({ idempotencyKey: 'retried' }), ctx)
    await processJob(
      prisma,
      batch({
        idempotencyKey: 'green',
        run: { status: 'passed', startedAt: new Date('2026-07-16T11:00:00Z') },
        executions: [execution('logs in', 'pass', 1000)],
      }),
      ctx,
    )
    await processJob(
      prisma,
      batch({
        idempotencyKey: 'rerun-of-a-pass',
        run: { status: 'passed', startedAt: new Date('2026-07-16T12:00:00Z') },
        executions: [
          execution('logs in', 'pass', 1000),
          execution('logs in', 'pass', 1000, { attempt: 2, retryOfIndex: 0 }),
        ],
      }),
      ctx,
    )
    await processJob(
      prisma,
      batch({
        idempotencyKey: 'skipped',
        run: { status: 'passed', startedAt: new Date('2026-07-16T13:00:00Z') },
        executions: [execution('logs in', 'skip', 0)],
      }),
      ctx,
    )

    const { mostFailing } = await getTestLeaderboards(prisma, ctx.projectId, 3650)
    expect(mostFailing).toHaveLength(1)
    expect(mostFailing[0]?.runs).toBe(3)
    expect(mostFailing[0]?.failedRuns).toBe(1)
    expect(mostFailing[0]?.failRate).toBeCloseTo(1 / 3)
  })

  it('ranks a test seen in too few runs below one with a real sample', async () => {
    const ctx = { ...(await seedProject()), now: NOW }
    for (const [index, status] of (['fail', 'pass', 'pass', 'pass'] as const).entries()) {
      await processJob(
        prisma,
        batch({
          idempotencyKey: `sampled-${index}`,
          run: { status: 'passed', startedAt: new Date('2026-07-16T10:00:00Z') },
          executions: [
            execution('sampled', status, 10),
            ...(index === 0 ? [execution('new', 'fail' as const, 10)] : []),
          ],
        }),
        ctx,
      )
    }

    const { mostFailing } = await getTestLeaderboards(prisma, ctx.projectId, 3650)
    expect(mostFailing.map((test) => [test.title, test.failedRuns, test.runs])).toEqual([
      ['sampled', 1, 4],
      ['new', 1, 1],
    ])
  })

  it('does not list a test that only failed after its first attempt', async () => {
    const ctx = { ...(await seedProject()), now: NOW }
    await processJob(
      prisma,
      batch({
        executions: [
          execution('logs in', 'pass', 1000),
          execution('logs in', 'fail', 1000, { attempt: 2, retryOfIndex: 0 }),
        ],
      }),
      ctx,
    )

    const { mostFailing } = await getTestLeaderboards(prisma, ctx.projectId, 3650)
    expect(mostFailing).toEqual([])
  })

  it('keeps hooks off the boards and counts the failing ones', async () => {
    const ctx = { ...(await seedProject()), now: NOW }
    await processJob(
      prisma,
      batch({
        executions: [
          execution('"before all" hook for "logs in"', 'fail', 40_000),
          execution('"after each" hook', 'fail', 40_000),
          execution('"before all" hook for "signs out"', 'fail', 40_000, { attempt: 2 }),
          execution('a "before all" hook is not in this title', 'fail', 20),
          execution('logs in', 'pass', 10),
        ],
      }),
      ctx,
    )

    const boards = await getTestLeaderboards(prisma, ctx.projectId, 3650)
    expect(boards.mostFailing.map((test) => test.title)).toEqual([
      'a "before all" hook is not in this title',
    ])
    expect(boards.slowest.map((test) => test.title)).toEqual([
      'a "before all" hook is not in this title',
      'logs in',
    ])
    expect(boards.failingHooks).toBe(3)
  })

  it('tells the variants of a test apart', async () => {
    const ctx = { ...(await seedProject()), now: NOW }
    await processJob(
      prisma,
      batch({
        executions: [
          execution('logs in', 'fail', 200, { params: { variant: 'firefox' } }),
          execution('logs in', 'pass', 100, { params: { variant: 'webkit' } }),
          execution('signs out', 'pass', 50),
        ],
      }),
      ctx,
    )

    const { slowest, mostFailing } = await getTestLeaderboards(prisma, ctx.projectId, 3650)
    expect(slowest.map((test) => [test.title, test.variant])).toEqual([
      ['logs in', 'firefox'],
      ['logs in', 'webkit'],
      ['signs out', null],
    ])
    expect(mostFailing[0]?.variant).toBe('firefox')
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
