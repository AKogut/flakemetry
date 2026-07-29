import type { IngestSpan } from '@flakemetry/contracts'
import { type Prisma, PrismaClient } from '@flakemetry/db'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'

import { flakyBoard } from '../flaky'
import { getRun, listRuns } from '../runs'
import { getRunSummaryByCommit } from '../summary'
import { getTest } from '../tests'
import { getExecutionTrace } from '../trace'

const hasDb = Boolean(process.env.DATABASE_URL)
const prisma = new PrismaClient()

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
})
