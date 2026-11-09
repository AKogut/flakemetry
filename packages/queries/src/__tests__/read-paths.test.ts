import type { IngestSpan } from '@flakemetry/contracts'
import { createPrismaClient, Prisma } from '@flakemetry/db'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'

import { countTestsWithoutSignal, flakyBoard } from '../flaky'
import { getRun, listRuns } from '../runs'
import { getRunSummaryByCommit, renderPrComment } from '../summary'
import { getTest } from '../tests'
import { getExecutionTrace } from '../trace'

const hasDb = Boolean(process.env.DATABASE_URL)
const prisma = createPrismaClient()

const COMMIT = 'abc1234'
const START = new Date('2026-07-16T10:00:00Z')

interface Seed {
  orgId: string
  projectId: string
  runId: string
  flakyIdentityId: string
  failIdentityId: string
  failExecutionId: string
  flakyExecutionId: string
}

const seed = async (): Promise<Seed> => {
  const org = await prisma.org.create({ data: { name: 'Acme', slug: `acme-${Date.now()}` } })
  const project = await prisma.project.create({
    data: { orgId: org.id, name: 'Web', slug: 'web' },
  })
  const tenant = { orgId: org.id, projectId: project.id }

  const run = await prisma.run.create({
    data: {
      ...tenant,
      idempotencyKey: 'run-read-1',
      commitSha: COMMIT,
      branch: 'main',
      ciProvider: 'github_actions',
      trigger: 'push',
      status: 'failed',
      startedAt: START,
      durationMs: 5000,
      failedCount: 1,
      flakyCount: 1,
    },
  })

  const flaky = await prisma.testIdentity.create({
    data: {
      ...tenant,
      fingerprint: 'fp-flaky',
      filePath: 'e2e/login.spec.ts',
      suite: 'auth',
      title: 'logs in',
      quarantined: true,
      firstSeenAt: START,
      lastSeenAt: START,
    },
  })
  const fail = await prisma.testIdentity.create({
    data: {
      ...tenant,
      fingerprint: 'fp-fail',
      filePath: 'e2e/checkout.spec.ts',
      suite: 'shop',
      title: 'pays',
      firstSeenAt: START,
      lastSeenAt: START,
    },
  })

  await prisma.flakyScore.create({
    data: {
      testIdentityId: flaky.id,
      ...tenant,
      score: 0.82,
      flipRate: 0.4,
      passOnRerunRate: 0.6,
      sameShaVariance: 0.3,
      entropy: 0.5,
      failIsolation: 1,
      modelVersion: 'test',
      quarantineCandidate: true,
      lastFlakedAt: START,
      reasonCodes: [
        { code: 'pass_on_rerun', message: 'passes when retried' },
      ] as Prisma.InputJsonValue,
    },
  })

  const spans: IngestSpan[] = [
    {
      spanId: 'span-root',
      parentSpanId: null,
      name: 'test',
      kind: 'step',
      status: 'error',
      startedAt: new Date('2026-07-16T10:00:01Z'),
      durationMs: 1800,
    },
  ]

  const failExec = await prisma.testExecution.create({
    data: {
      ...tenant,
      runId: run.id,
      ordinal: 0,
      testIdentityId: fail.id,
      status: 'fail',
      attempt: 1,
      durationMs: 1800,
      errorMessage: 'Timeout 30000ms exceeded',
      startedAt: new Date('2026-07-16T10:00:01Z'),
      otelTraceId: 'trace-1',
      otelSpanId: 'span-root',
      spans: spans as unknown as Prisma.InputJsonValue,
      artifactsRef: [
        { name: 'shot.png', contentType: 'image/png', path: 'a', key: 'k/shot.png', sizeBytes: 10 },
      ] as Prisma.InputJsonValue,
    },
  })

  const flakyExec = await prisma.testExecution.create({
    data: {
      ...tenant,
      runId: run.id,
      ordinal: 1,
      testIdentityId: flaky.id,
      status: 'flaky',
      attempt: 2,
      durationMs: 1400,
      startedAt: new Date('2026-07-16T10:00:03Z'),
    },
  })

  const day = new Date('2026-07-16T00:00:00Z')
  for (const [identityId, flakyCount] of [
    [flaky.id, 3],
    [fail.id, 0],
  ] as const) {
    await prisma.dailyTestStats.create({
      data: {
        ...tenant,
        testIdentityId: identityId,
        day,
        total: 5,
        passed: 5 - flakyCount,
        failed: 0,
        flaky: flakyCount,
        skipped: 0,
        avgDurationMs: 1500,
      },
    })
  }

  return {
    orgId: org.id,
    projectId: project.id,
    runId: run.id,
    flakyIdentityId: flaky.id,
    failIdentityId: fail.id,
    failExecutionId: failExec.id,
    flakyExecutionId: flakyExec.id,
  }
}

describe.skipIf(!hasDb)('queries read paths', () => {
  beforeEach(async () => {
    await prisma.dailyTestStats.deleteMany()
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

  it('getExecutionTrace returns tenant, spans (as dates) and artifacts', async () => {
    const s = await seed()
    const trace = await getExecutionTrace(prisma, s.projectId, s.failExecutionId)

    expect(trace).not.toBeNull()
    expect(trace?.orgId).toBe(s.orgId)
    expect(trace?.traceId).toBe('trace-1')
    expect(trace?.spans).toHaveLength(1)
    expect(trace?.spans[0]?.startedAt).toBeInstanceOf(Date)
    expect(trace?.artifacts).toHaveLength(1)
    expect(trace?.commitSha).toBe(COMMIT)
  })

  it('getExecutionTrace does not leak across projects', async () => {
    const s = await seed()
    const other = await prisma.project.create({
      data: { orgId: s.orgId, name: 'Other', slug: 'other' },
    })
    const leaked = await getExecutionTrace(prisma, other.id, s.failExecutionId)
    expect(leaked).toBeNull()
  })

  it('getRun aggregates status counts and lists executions', async () => {
    const s = await seed()
    const run = await getRun(prisma, s.projectId, s.runId)

    expect(run).not.toBeNull()
    expect(run?.counts.total).toBe(2)
    expect(run?.counts.failed).toBe(1)
    expect(run?.counts.flaky).toBe(1)
    expect(run?.executions).toHaveLength(2)
  })

  it('listRuns returns the run with counts and no next cursor', async () => {
    const s = await seed()
    const result = await listRuns(prisma, s.projectId, { limit: 20 })

    expect(result.items).toHaveLength(1)
    expect(result.items[0]?.commitSha).toBe(COMMIT)
    expect(result.items[0]?.counts).toEqual({
      total: 2,
      passed: 0,
      failed: 1,
      skipped: 0,
      flaky: 1,
    })
    expect(result.nextCursor).toBeNull()
  })

  it('flakyBoard ranks by score and honours includeQuarantined', async () => {
    const s = await seed()

    const withQuarantined = await flakyBoard(prisma, s.projectId, {
      limit: 20,
      minScore: 0,
      includeQuarantined: true,
    })
    expect(withQuarantined.items).toHaveLength(1)
    expect(withQuarantined.items[0]?.testIdentityId).toBe(s.flakyIdentityId)
    expect(withQuarantined.items[0]?.quarantined).toBe(true)

    const withoutQuarantined = await flakyBoard(prisma, s.projectId, {
      limit: 20,
      minScore: 0,
      includeQuarantined: false,
    })
    expect(withoutQuarantined.items).toHaveLength(0)
  })

  it('getTest returns oldest-first history and reason codes', async () => {
    const s = await seed()
    const detail = await getTest(prisma, s.projectId, s.flakyIdentityId, 50)

    expect(detail).not.toBeNull()
    expect(detail?.score).toBeCloseTo(0.82)
    expect(detail?.reasonCodes.length).toBeGreaterThan(0)
    expect(detail?.history[0]?.executionId).toBe(s.flakyExecutionId)
    expect(detail?.aliases).toEqual([])
    expect(detail?.stitches).toEqual([])
  })

  describe('what a test page can offer for each execution', () => {
    const seedExecutions = async (
      rows: readonly {
        ordinal: number
        spans?: Prisma.InputJsonValue | typeof Prisma.JsonNull
        artifactsRef?: Prisma.InputJsonValue | typeof Prisma.JsonNull
        durationMs: number
        status?: 'pass' | 'fail' | 'flaky' | 'skip'
        attempt?: number
      }[],
    ) => {
      const org = await prisma.org.create({ data: { name: 'Facts', slug: `f-${Date.now()}` } })
      const project = await prisma.project.create({
        data: { orgId: org.id, name: 'Web', slug: 'web' },
      })
      const tenant = { orgId: org.id, projectId: project.id }
      const run = await prisma.run.create({
        data: {
          ...tenant,
          idempotencyKey: 'facts-1',
          commitSha: COMMIT,
          branch: 'main',
          ciProvider: 'github_actions',
          trigger: 'push',
          status: 'passed',
          startedAt: START,
        },
      })
      const identity = await prisma.testIdentity.create({
        data: {
          ...tenant,
          fingerprint: 'fp-facts',
          filePath: 'a.spec.ts',
          suite: 's',
          title: 't',
          firstSeenAt: START,
          lastSeenAt: START,
        },
      })
      for (const row of rows) {
        await prisma.testExecution.create({
          data: {
            ...tenant,
            runId: run.id,
            testIdentityId: identity.id,
            ordinal: row.ordinal,
            status: row.status ?? 'pass',
            attempt: row.attempt ?? row.ordinal + 1,
            durationMs: row.durationMs,
            startedAt: START,
            spans: row.spans,
            artifactsRef: row.artifactsRef,
          },
        })
      }
      return { projectId: project.id, testId: identity.id }
    }

    it('tells a recorded span tree from JSON null, an empty array and no value', async () => {
      const span = { spanId: 's1', parentSpanId: null, name: 'step' }
      const { projectId, testId } = await seedExecutions([
        { ordinal: 0, durationMs: 10, spans: [span] },
        { ordinal: 1, durationMs: 10, spans: Prisma.JsonNull },
        { ordinal: 2, durationMs: 10, spans: [] },
        { ordinal: 3, durationMs: 10 },
        { ordinal: 4, durationMs: 10, artifactsRef: [{ name: 'shot.png' }] },
      ])
      const detail = await getTest(prisma, projectId, testId, 50)
      const byAttempt = new Map(detail?.history.map((point) => [point.attempt, point]))
      expect(byAttempt.get(1)?.hasSpans).toBe(true)
      expect(byAttempt.get(2)?.hasSpans).toBe(false)
      expect(byAttempt.get(3)?.hasSpans).toBe(false)
      expect(byAttempt.get(4)?.hasSpans).toBe(false)
      expect(byAttempt.get(4)?.hasArtifacts).toBe(false)
      expect(byAttempt.get(5)?.hasArtifacts).toBe(true)
    })

    it('knows a duration only when the run measured one', async () => {
      const untimed = await seedExecutions([
        { ordinal: 0, durationMs: 0 },
        { ordinal: 1, durationMs: 0, status: 'skip' },
      ])
      const unknown = await getTest(prisma, untimed.projectId, untimed.testId, 50)
      expect(unknown?.history.map((point) => point.durationKnown)).toEqual([false, false])

      await prisma.testExecution.deleteMany()
      await prisma.testIdentity.deleteMany()
      await prisma.run.deleteMany()
      await prisma.project.deleteMany()
      await prisma.org.deleteMany()

      const timed = await seedExecutions([
        { ordinal: 0, durationMs: 0 },
        { ordinal: 1, durationMs: 40 },
      ])
      const known = await getTest(prisma, timed.projectId, timed.testId, 50)
      expect(known?.history.map((point) => point.durationKnown)).toEqual([true, true])
    })

    it.each([
      ['first attempt stored first', [1, 2]],
      ['retry stored first', [2, 1]],
    ])('orders retries of one timestamp oldest attempt first: %s', async (_name, attempts) => {
      const { projectId, testId } = await seedExecutions(
        attempts.map((attempt, ordinal) => ({
          ordinal,
          durationMs: 10,
          attempt,
          status: attempt === 1 ? ('fail' as const) : ('flaky' as const),
        })),
      )
      const detail = await getTest(prisma, projectId, testId, 50)
      expect(detail?.history.map((point) => point.status)).toEqual(['fail', 'flaky'])
    })

    it('keeps the run time of a stitch', async () => {
      const { projectId, testId } = await seedExecutions([{ ordinal: 0, durationMs: 10 }])
      const happened = new Date('2026-06-01T08:00:00Z')
      const identity = await prisma.testIdentity.findUniqueOrThrow({ where: { id: testId } })
      await prisma.identityStitch.create({
        data: {
          orgId: identity.orgId,
          projectId,
          testIdentityId: testId,
          level: 'L2',
          fromFingerprint: 'old',
          toFilePath: 'a.spec.ts',
          toTitle: 't',
          runStartedAt: happened,
        },
      })
      const detail = await getTest(prisma, projectId, testId, 50)
      expect(detail?.stitches[0]?.runStartedAt).toEqual(happened)
      expect(detail?.stitches[0]?.createdAt).not.toEqual(happened)
    })
  })

  describe('run duration when the report has none', () => {
    const seedRun = async (
      stored: number | null,
      executions: readonly { startedAt: Date; durationMs: number; status?: 'pass' | 'skip' }[],
    ) => {
      const org = await prisma.org.create({ data: { name: 'Time', slug: `t-${Date.now()}` } })
      const project = await prisma.project.create({
        data: { orgId: org.id, name: 'Web', slug: 'web' },
      })
      const tenant = { orgId: org.id, projectId: project.id }
      const run = await prisma.run.create({
        data: {
          ...tenant,
          idempotencyKey: 'time-1',
          commitSha: COMMIT,
          branch: 'main',
          ciProvider: 'github_actions',
          trigger: 'push',
          status: 'passed',
          startedAt: START,
          durationMs: stored,
        },
      })
      for (const [index, execution] of executions.entries()) {
        const identity = await prisma.testIdentity.create({
          data: {
            ...tenant,
            fingerprint: `fp-${index}`,
            filePath: 'a.spec.ts',
            suite: 's',
            title: `t${index}`,
            firstSeenAt: START,
            lastSeenAt: START,
          },
        })
        await prisma.testExecution.create({
          data: {
            ...tenant,
            runId: run.id,
            testIdentityId: identity.id,
            ordinal: index,
            status: execution.status ?? 'pass',
            attempt: 1,
            durationMs: execution.durationMs,
            startedAt: execution.startedAt,
          },
        })
      }
      return project.id
    }

    it('sums test durations and says so when no test has its own start', async () => {
      const projectId = await seedRun(null, [
        { startedAt: START, durationMs: 2000 },
        { startedAt: START, durationMs: 3000 },
        { startedAt: START, durationMs: 0, status: 'skip' },
      ])
      const { items } = await listRuns(prisma, projectId, { limit: 20 })
      expect(items[0]).toMatchObject({ durationMs: 5000, durationEstimated: true })
    })

    it('measures from the first start to the last end when tests have their own starts', async () => {
      const projectId = await seedRun(null, [
        { startedAt: new Date('2026-07-16T10:00:00Z'), durationMs: 1000 },
        { startedAt: new Date('2026-07-16T10:00:10Z'), durationMs: 500 },
      ])
      const { items } = await listRuns(prisma, projectId, { limit: 20 })
      expect(items[0]).toMatchObject({ durationMs: 10_500, durationEstimated: false })
    })

    it('stays unknown when nothing was measured', async () => {
      const projectId = await seedRun(null, [
        { startedAt: START, durationMs: 0 },
        { startedAt: START, durationMs: 0 },
      ])
      const { items } = await listRuns(prisma, projectId, { limit: 20 })
      expect(items[0]).toMatchObject({ durationMs: null, durationEstimated: false })
    })

    it('does not trust a stored duration shorter than a test in the run', async () => {
      const projectId = await seedRun(4, [
        { startedAt: new Date('2026-07-16T10:00:00Z'), durationMs: 800 },
        { startedAt: new Date('2026-07-16T10:00:05Z'), durationMs: 700 },
      ])
      const { items } = await listRuns(prisma, projectId, { limit: 20 })
      expect(items[0]).toMatchObject({ durationMs: 5700, durationEstimated: false })
    })

    it('keeps a stored duration that is plausible', async () => {
      const projectId = await seedRun(5000, [{ startedAt: START, durationMs: 800 }])
      const { items } = await listRuns(prisma, projectId, { limit: 20 })
      expect(items[0]).toMatchObject({ durationMs: 5000, durationEstimated: false })
    })
  })

  it('the board skips tests with no failure on record and breaks ties by the latest one', async () => {
    const s = await seed()
    const add = async (
      fingerprint: string,
      score: number,
      lastFlakedAt: Date | null,
    ): Promise<string> => {
      const identity = await prisma.testIdentity.create({
        data: {
          orgId: s.orgId,
          projectId: s.projectId,
          fingerprint,
          filePath: 'e2e/x.spec.ts',
          suite: 'x',
          title: fingerprint,
          firstSeenAt: START,
          lastSeenAt: START,
        },
      })
      await prisma.flakyScore.create({
        data: {
          testIdentityId: identity.id,
          orgId: s.orgId,
          projectId: s.projectId,
          score,
          flipRate: 0,
          passOnRerunRate: 0,
          sameShaVariance: 0,
          entropy: 0,
          failIsolation: 0,
          modelVersion: 'test',
          lastFlakedAt,
          reasonCodes: [] as Prisma.InputJsonValue,
        },
      })
      return identity.id
    }
    const older = await add('older', 0.2, new Date('2026-07-01T00:00:00Z'))
    const newer = await add('newer', 0.2, new Date('2026-07-10T00:00:00Z'))
    const clean = await add('clean', 0.9, null)

    const signal = await flakyBoard(
      prisma,
      s.projectId,
      { limit: 20, minScore: 0, includeQuarantined: true },
      { withSignalOnly: true },
    )
    expect(signal.items.map((item) => item.testIdentityId)).toEqual([
      s.flakyIdentityId,
      newer,
      older,
    ])

    const everything = await flakyBoard(prisma, s.projectId, {
      limit: 20,
      minScore: 0,
      includeQuarantined: true,
    })
    expect(everything.items.map((item) => item.testIdentityId)).toContain(clean)
    await expect(countTestsWithoutSignal(prisma, s.projectId)).resolves.toBe(1)
  })

  it('getRunSummaryByCommit rolls up failed and flaky tests', async () => {
    const s = await seed()
    const summary = await getRunSummaryByCommit(prisma, s.projectId, COMMIT)

    expect(summary).not.toBeNull()
    expect(summary?.failed).toBe(1)
    expect(summary?.flaky).toBe(1)
    expect(summary?.tests[0]?.status).toBe('fail')
    const flakyRow = summary?.tests.find((test) => test.status === 'flaky')
    expect(flakyRow?.topReason).toBe('passes when retried')
  })

  describe('a CI run with several jobs', () => {
    const CI_COMMIT = 'matrix0000000'

    const seedJobs = async (
      jobs: readonly { key: string; startedAt: Date; status: 'pass' | 'fail' }[],
    ) => {
      const org = await prisma.org.create({ data: { name: 'Matrix', slug: `m-${Date.now()}` } })
      const project = await prisma.project.create({
        data: { orgId: org.id, name: 'Web', slug: 'web' },
      })
      const tenant = { orgId: org.id, projectId: project.id }
      const identities = new Map<string, string>()
      for (const job of jobs) {
        const run = await prisma.run.create({
          data: {
            ...tenant,
            idempotencyKey: job.key,
            commitSha: CI_COMMIT,
            branch: 'main',
            ciProvider: 'github_actions',
            ciRunId: '777',
            trigger: 'push',
            status: job.status === 'fail' ? 'failed' : 'passed',
            startedAt: job.startedAt,
          },
        })
        const name = job.key.split('/')[0] ?? job.key
        let identityId = identities.get(name)
        if (!identityId) {
          const identity = await prisma.testIdentity.create({
            data: {
              ...tenant,
              fingerprint: `fp-${name}`,
              filePath: `${name}.spec.ts`,
              suite: '',
              title: name,
              firstSeenAt: job.startedAt,
              lastSeenAt: job.startedAt,
            },
          })
          identityId = identity.id
          identities.set(name, identityId)
        }
        await prisma.testExecution.create({
          data: {
            ...tenant,
            runId: run.id,
            testIdentityId: identityId,
            status: job.status,
            attempt: 1,
            startedAt: job.startedAt,
            durationMs: 10,
          },
        })
      }
      return project.id
    }

    it('reports a failure from a job other than the latest one', async () => {
      const projectId = await seedJobs([
        { key: 'webkit/1', startedAt: new Date(START.getTime() + 1000), status: 'fail' },
        { key: 'chromium/1', startedAt: new Date(START.getTime() + 2000), status: 'pass' },
      ])

      const summary = await getRunSummaryByCommit(prisma, projectId, CI_COMMIT)

      expect(summary?.failed).toBe(1)
      expect(summary?.tests[0]?.title).toBe('webkit')
      expect(summary?.runStatus).toBe('failed')
    })

    it('names the variant in the summary and the PR comment', async () => {
      const projectId = await seedJobs([
        { key: 'webkit/1', startedAt: new Date(START.getTime() + 1000), status: 'fail' },
      ])
      await prisma.testIdentity.updateMany({
        where: { projectId },
        data: { params: { variant: 'webkit' }, paramsHash: 'abc' },
      })

      const summary = await getRunSummaryByCommit(prisma, projectId, CI_COMMIT)
      expect(summary?.tests[0]?.variant).toBe('webkit')
      expect(renderPrComment(summary!)).toContain('webkit · webkit')
    })

    it('lets a later attempt of the CI run replace an earlier failure', async () => {
      const projectId = await seedJobs([
        { key: 'webkit/attempt-1', startedAt: new Date(START.getTime() + 1000), status: 'fail' },
        { key: 'webkit/attempt-2', startedAt: new Date(START.getTime() + 2000), status: 'pass' },
      ])

      const summary = await getRunSummaryByCommit(prisma, projectId, CI_COMMIT)

      expect(summary?.failed).toBe(0)
      expect(summary?.runStatus).toBe('passed')
    })
  })
})
