import { buildApp } from '@flakemetry/api/app'
import { generateToken, hashToken, IngestionQueue, PrismaClient } from '@flakemetry/db'
import { exportRunOverOtlp, TestRunRecorder } from '@flakemetry/sdk'
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest'

import { createEventBus, type DomainEventMap } from '../events'
import { createWorker, type Worker } from '../runner'

const hasDb = Boolean(process.env.DATABASE_URL)
const prisma = new PrismaClient()

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

const drain = async (worker: Worker): Promise<number> => {
  let processed = 0
  for (let attempt = 0; attempt < 20; attempt += 1) {
    processed += await worker.tick()
    const pending = await prisma.ingestionJob.count({ where: { status: { in: ['pending'] } } })
    if (pending === 0) return processed
    await sleep(25)
  }
  return processed
}

const recordRun = (commitSha: string, failFirstAttempt: boolean) => {
  const recorder = new TestRunRecorder({
    project: 'acme/web',
    commitSha,
    branch: 'main',
    ciProvider: 'github_actions',
    trigger: 'push',
    ciRunId: `run-${commitSha}`,
  })
  recorder.startRun(new Date('2026-07-16T10:00:00Z'))
  recorder.record({
    filePath: 'e2e/login.spec.ts',
    suite: 'auth',
    title: 'logs in',
    status: failFirstAttempt ? 'fail' : 'pass',
    attempt: 1,
    startedAt: new Date('2026-07-16T10:00:01Z'),
    durationMs: 1800,
    ...(failFirstAttempt
      ? { error: { type: 'TimeoutError', message: 'Timeout 30000ms exceeded', stack: 'at login' } }
      : {}),
  })
  if (failFirstAttempt) {
    recorder.record({
      filePath: 'e2e/login.spec.ts',
      suite: 'auth',
      title: 'logs in',
      status: 'flaky',
      attempt: 2,
      retryOfIndex: 0,
      startedAt: new Date('2026-07-16T10:00:03Z'),
      durationMs: 1400,
    })
  }
  recorder.finishRun(failFirstAttempt ? 'failed' : 'passed', new Date('2026-07-16T10:00:05Z'))
  return recorder
}

describe.skipIf(!hasDb)('full ingestion chain', () => {
  let app: ReturnType<typeof buildApp>
  let endpoint: string
  let token: string
  let orgId: string
  let projectId: string

  beforeEach(async () => {
    await prisma.policyChange.deleteMany()
    await prisma.projectPolicy.deleteMany()
    await prisma.flakyScore.deleteMany()
    await prisma.testExecution.deleteMany()
    await prisma.testIdentity.deleteMany()
    await prisma.run.deleteMany()
    await prisma.ingestionJob.deleteMany()
    await prisma.ingestToken.deleteMany()
    await prisma.project.deleteMany()
    await prisma.org.deleteMany()

    const org = await prisma.org.create({ data: { name: 'Acme', slug: `acme-${Date.now()}` } })
    const project = await prisma.project.create({
      data: { orgId: org.id, name: 'Web', slug: 'web' },
    })
    orgId = org.id
    projectId = project.id
    token = generateToken()
    await prisma.ingestToken.create({
      data: { orgId: org.id, projectId: project.id, name: 'ci', tokenHash: hashToken(token) },
    })

    app = buildApp({ prisma })
    endpoint = await app.listen({ port: 0, host: '127.0.0.1' })
  })

  afterEach(async () => {
    await app.close()
  })

  afterAll(async () => {
    await prisma.$disconnect()
  })

  it('carries a real OTLP export through queue and worker into scored rows', async () => {
    const events = createEventBus()
    const processedEvents: DomainEventMap['run.processed'][] = []
    events.on('run.processed', (payload) => processedEvents.push(payload))

    const worker = createWorker(prisma, new IngestionQueue(prisma), { events })

    await exportRunOverOtlp(recordRun('aaa1111', true), 'e2e-run-000001', { endpoint, token })
    expect(await prisma.ingestionJob.count()).toBe(1)

    expect(await drain(worker)).toBe(1)

    const run = await prisma.run.findFirstOrThrow()
    expect(run.commitSha).toBe('aaa1111')
    expect(run.branch).toBe('main')
    expect(run.status).toBe('failed')

    const executions = await prisma.testExecution.findMany({ orderBy: { attempt: 'asc' } })
    expect(executions).toHaveLength(2)
    expect(executions[0]?.status).toBe('fail')
    expect(executions[0]?.errorMessage).toBe('Timeout 30000ms exceeded')
    expect(executions[1]?.status).toBe('flaky')
    expect(executions[1]?.retryOf).toBe(executions[0]?.id)

    const identity = await prisma.testIdentity.findFirstOrThrow()
    expect(identity.filePath).toBe('e2e/login.spec.ts')
    expect(identity.title).toBe('logs in')

    const score = await prisma.flakyScore.findFirstOrThrow()
    expect(score.testIdentityId).toBe(identity.id)
    expect(score.passOnRerunRate).toBeGreaterThan(0)
    expect((score.reasonCodes as { code: string }[]).length).toBeGreaterThan(0)

    expect(processedEvents).toHaveLength(1)
    expect(processedEvents[0]?.executions).toBe(2)
  })

  it('accumulates history across runs and stays idempotent on re-delivery', async () => {
    const worker = createWorker(prisma, new IngestionQueue(prisma))

    await exportRunOverOtlp(recordRun('aaa1111', true), 'e2e-run-000001', { endpoint, token })
    await drain(worker)
    await exportRunOverOtlp(recordRun('bbb2222', false), 'e2e-run-000002', { endpoint, token })
    await drain(worker)

    expect(await prisma.run.count()).toBe(2)
    expect(await prisma.testIdentity.count()).toBe(1)
    expect(await prisma.testExecution.count()).toBe(3)

    await exportRunOverOtlp(recordRun('bbb2222', false), 'e2e-run-000002', { endpoint, token })
    expect(await prisma.ingestionJob.count()).toBe(2)
    await drain(worker)

    expect(await prisma.run.count()).toBe(2)
    expect(await prisma.testExecution.count()).toBe(3)
  })

  it('applies the project policy the worker loads from the database', async () => {
    await prisma.projectPolicy.create({
      data: { projectId, orgId, flakyThreshold: 0.01, minSamples: 1 },
    })

    const worker = createWorker(prisma, new IngestionQueue(prisma))
    await exportRunOverOtlp(recordRun('aaa1111', true), 'e2e-run-000001', { endpoint, token })
    await drain(worker)

    const scored = await prisma.flakyScore.findFirstOrThrow()
    expect(scored.quarantineCandidate).toBe(true)
  })
})
