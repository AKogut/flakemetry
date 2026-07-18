import type { IngestRunBatch } from '@flakemetry/contracts'
import { PrismaClient } from '@flakemetry/db'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'

import { createEventBus, type DomainEventMap } from '../events'
import { processJob } from '../processor'

const hasDb = Boolean(process.env.DATABASE_URL)
const prisma = new PrismaClient()

const NOW = new Date('2026-07-16T12:00:00Z')

const seedProject = async () => {
  const org = await prisma.org.create({ data: { name: 'Acme', slug: `acme-${Date.now()}` } })
  const project = await prisma.project.create({ data: { orgId: org.id, name: 'Web', slug: 'web' } })
  return { orgId: org.id, projectId: project.id }
}

const batch = (overrides: Partial<IngestRunBatch> = {}): IngestRunBatch => ({
  contractVersion: '0.1.0',
  idempotencyKey: 'run-000001',
  resource: {
    ciProvider: 'github_actions',
    commitSha: 'abc1234',
    branch: 'main',
    trigger: 'push',
  },
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
  ...overrides,
})

describe.skipIf(!hasDb)('processJob', () => {
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

  it('materializes a run, executions, one identity and a flaky score', async () => {
    const ctx = { ...(await seedProject()), now: NOW }
    const result = await processJob(prisma, batch(), ctx)

    expect(result.executions).toBe(2)
    expect(result.newIdentities).toBe(1)
    expect(result.scoredIdentities).toBe(1)

    const executions = await prisma.testExecution.findMany({ orderBy: { attempt: 'asc' } })
    expect(executions).toHaveLength(2)
    expect(executions[1]?.retryOf).toBe(executions[0]?.id)

    const identity = await prisma.testIdentity.findFirstOrThrow()
    expect(identity.suite).toBe('auth')

    const score = await prisma.flakyScore.findFirstOrThrow()
    expect(score.passOnRerunRate).toBeGreaterThan(0)
    expect(score.failIsolation).toBe(1)
    expect(Array.isArray(score.reasonCodes)).toBe(true)
    expect((score.reasonCodes as { code: string }[]).length).toBeGreaterThan(0)
  })

  it('is idempotent: re-processing the same batch does not duplicate executions', async () => {
    const ctx = { ...(await seedProject()), now: NOW }
    await processJob(prisma, batch(), ctx)
    await processJob(prisma, batch(), ctx)

    expect(await prisma.run.count()).toBe(1)
    expect(await prisma.testExecution.count()).toBe(2)
    expect(await prisma.testIdentity.count()).toBe(1)
  })

  it('emits domain events for identities, scores and the processed run', async () => {
    const events = createEventBus()
    const created: DomainEventMap['identity.created'][] = []
    const scored: DomainEventMap['score.updated'][] = []
    const processed: DomainEventMap['run.processed'][] = []
    events.on('identity.created', (payload) => created.push(payload))
    events.on('score.updated', (payload) => scored.push(payload))
    events.on('run.processed', (payload) => processed.push(payload))

    const ctx = { ...(await seedProject()), now: NOW, events }
    const result = await processJob(prisma, batch(), ctx)

    expect(created).toHaveLength(1)
    expect(created[0]?.fingerprint).toBeTruthy()
    expect(scored).toHaveLength(1)
    expect(scored[0]?.testIdentityId).toBe(created[0]?.testIdentityId)
    expect(processed).toEqual([
      {
        runId: result.runId,
        projectId: ctx.projectId,
        executions: 2,
        newIdentities: 1,
        movedIdentities: 0,
      },
    ])
  })

  it('emits identity.moved when a test file moves', async () => {
    const events = createEventBus()
    const moved: DomainEventMap['identity.moved'][] = []
    events.on('identity.moved', (payload) => moved.push(payload))

    const ctx = { ...(await seedProject()), now: NOW, events }
    await processJob(prisma, batch(), ctx)
    await processJob(
      prisma,
      batch({
        idempotencyKey: 'run-000002',
        executions: [
          {
            filePath: 'e2e/auth/login.spec.ts',
            suite: 'auth',
            title: 'logs in',
            status: 'pass',
            attempt: 1,
            startedAt: new Date('2026-07-16T11:00:00Z'),
            durationMs: 1600,
          },
        ],
      }),
      ctx,
    )

    expect(moved).toHaveLength(1)
    expect(moved[0]?.alias).toBeTruthy()
  })

  it('stitches history across a file move via L2 identity resolution', async () => {
    const ctx = { ...(await seedProject()), now: NOW }
    await processJob(prisma, batch(), ctx)

    const moved = batch({
      idempotencyKey: 'run-000002',
      executions: [
        {
          filePath: 'e2e/auth/login.spec.ts',
          suite: 'auth',
          title: 'logs in',
          status: 'pass',
          attempt: 1,
          startedAt: new Date('2026-07-16T11:00:00Z'),
          durationMs: 1600,
        },
      ],
    })
    const result = await processJob(prisma, moved, ctx)

    expect(result.movedIdentities).toBe(1)
    expect(await prisma.testIdentity.count()).toBe(1)

    const identity = await prisma.testIdentity.findFirstOrThrow()
    expect(identity.filePath).toBe('e2e/auth/login.spec.ts')
    expect(identity.aliases.length).toBe(1)

    const executions = await prisma.testExecution.count({
      where: { testIdentityId: identity.id },
    })
    expect(executions).toBe(3)
  })
})
