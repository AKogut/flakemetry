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

const greenBatch = (idempotencyKey: string): IngestRunBatch =>
  batch({
    idempotencyKey,
    run: { status: 'passed', startedAt: new Date('2026-07-16T11:00:00Z') },
    executions: [
      {
        filePath: 'e2e/login.spec.ts',
        suite: 'auth',
        title: 'logs in',
        status: 'pass',
        attempt: 1,
        startedAt: new Date('2026-07-16T11:00:01Z'),
        durationMs: 900,
      },
    ],
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

  it('is idempotent: re-processing keeps stable execution ids and occurrence counts', async () => {
    const ctx = { ...(await seedProject()), now: NOW }
    const ids = async () =>
      (
        await prisma.testExecution.findMany({ orderBy: { ordinal: 'asc' }, select: { id: true } })
      ).map((row) => row.id)

    await processJob(prisma, batch(), ctx)
    const before = await ids()
    const sigBefore = await prisma.errorSignature.findFirstOrThrow({
      select: { occurrenceCount: true },
    })

    await processJob(prisma, batch(), ctx)
    const after = await ids()
    const sigAfter = await prisma.errorSignature.findFirstOrThrow({
      select: { occurrenceCount: true },
    })

    expect(await prisma.run.count()).toBe(1)
    expect(await prisma.testExecution.count()).toBe(2)
    expect(await prisma.testIdentity.count()).toBe(1)
    expect(after).toEqual(before)
    expect(sigAfter.occurrenceCount).toBe(sigBefore.occurrenceCount)
  })

  it('emits flaky.detected and quarantine.changed when a test crosses into quarantine', async () => {
    const events = createEventBus()
    const flaky: DomainEventMap['flaky.detected'][] = []
    const quarantine: DomainEventMap['quarantine.changed'][] = []
    events.on('flaky.detected', (payload) => flaky.push(payload))
    events.on('quarantine.changed', (payload) => quarantine.push(payload))

    const ctx = {
      ...(await seedProject()),
      now: NOW,
      threshold: 0.01,
      minSamples: 1,
      quarantineEnabled: true,
      events,
    }
    await processJob(prisma, batch(), ctx)

    expect(flaky).toHaveLength(1)
    expect(flaky[0]?.title).toBe('logs in')
    expect(flaky[0]?.suite).toBe('auth')
    expect(quarantine).toHaveLength(1)
    expect(quarantine[0]?.quarantined).toBe(true)

    const healthEvents = await prisma.testHealthEvent.findMany({
      where: { projectId: ctx.projectId },
      select: { kind: true, createdAt: true },
    })
    const kinds = healthEvents.map((event) => event.kind).sort()
    expect(kinds).toEqual(['flaked', 'quarantined'])
    expect(healthEvents.every((event) => event.createdAt.getTime() === NOW.getTime())).toBe(true)
  })

  it('does not re-quarantine a test a person released', async () => {
    const ctx = {
      ...(await seedProject()),
      now: NOW,
      threshold: 0.01,
      minSamples: 1,
      quarantineEnabled: true,
    }
    await processJob(prisma, batch(), ctx)

    const quarantined = await prisma.testIdentity.findFirstOrThrow({
      where: { projectId: ctx.projectId },
    })
    expect(quarantined.quarantined).toBe(true)

    await prisma.testIdentity.update({
      where: { id: quarantined.id },
      data: { quarantined: false, quarantineReason: null, quarantineOverride: 'released' },
    })

    await processJob(prisma, batch({ idempotencyKey: 'run-2' }), ctx)

    // The score still says quarantine. A person said otherwise, and a control the next run
    // silently undoes is worse than no control at all.
    const after = await prisma.testIdentity.findUniqueOrThrow({ where: { id: quarantined.id } })
    expect(after.quarantined).toBe(false)
    expect(after.quarantineOverride).toBe('released')
  })

  it('does not release a test a person quarantined by hand', async () => {
    const ctx = {
      ...(await seedProject()),
      now: NOW,
      threshold: 0.99,
      minSamples: 1,
      quarantineEnabled: true,
      quarantineCooldownRuns: 1,
    }
    await processJob(prisma, batch(), ctx)

    const identity = await prisma.testIdentity.findFirstOrThrow({
      where: { projectId: ctx.projectId },
    })
    // A threshold of 0.99 means the scorer would never quarantine this on its own, so any
    // release below is the automation overriding the person rather than agreeing with them.
    expect(identity.quarantined).toBe(false)

    await prisma.testIdentity.update({
      where: { id: identity.id },
      data: { quarantined: true, quarantineReason: 'manual', quarantineOverride: 'quarantined' },
    })

    // A clean run, so the cooldown window is satisfied and the automation would release it.
    // Without this the test passes on the cooldown alone and proves nothing about overrides.
    await processJob(prisma, greenBatch('run-2'), ctx)

    const after = await prisma.testIdentity.findUniqueOrThrow({ where: { id: identity.id } })
    expect(after.quarantined).toBe(true)
    expect(after.quarantineReason).toBe('manual')
  })

  it('would have released that test if nobody had decided', async () => {
    const ctx = {
      ...(await seedProject()),
      now: NOW,
      threshold: 0.99,
      minSamples: 1,
      quarantineEnabled: true,
      quarantineCooldownRuns: 1,
    }
    await processJob(prisma, batch(), ctx)

    const identity = await prisma.testIdentity.findFirstOrThrow({
      where: { projectId: ctx.projectId },
    })
    await prisma.testIdentity.update({
      where: { id: identity.id },
      data: { quarantined: true, quarantineReason: 'auto: flaky score above threshold' },
    })

    await processJob(prisma, greenBatch('run-2'), ctx)

    // Guard the guard: the same setup without an override does get released, so the test
    // above is held up by the override rather than by the cooldown never being satisfied.
    expect(
      (await prisma.testIdentity.findUniqueOrThrow({ where: { id: identity.id } })).quarantined,
    ).toBe(false)
  })

  it('resumes deciding once the test is handed back', async () => {
    const ctx = {
      ...(await seedProject()),
      now: NOW,
      threshold: 0.01,
      minSamples: 1,
      quarantineEnabled: true,
    }
    await processJob(prisma, batch(), ctx)

    const identity = await prisma.testIdentity.findFirstOrThrow({
      where: { projectId: ctx.projectId },
    })
    await prisma.testIdentity.update({
      where: { id: identity.id },
      data: { quarantined: false, quarantineOverride: 'released' },
    })
    await processJob(prisma, batch({ idempotencyKey: 'run-2' }), ctx)
    expect(
      (await prisma.testIdentity.findUniqueOrThrow({ where: { id: identity.id } })).quarantined,
    ).toBe(false)

    await prisma.testIdentity.update({
      where: { id: identity.id },
      data: { quarantineOverride: null },
    })
    await processJob(prisma, batch({ idempotencyKey: 'run-3' }), ctx)

    // Guard the guard: without this the two tests above would pass just as well if
    // enforceQuarantine had stopped working altogether.
    expect(
      (await prisma.testIdentity.findUniqueOrThrow({ where: { id: identity.id } })).quarantined,
    ).toBe(true)
  })

  it('correlates parallel shards so a co-failing test is not scored as isolated', async () => {
    const ctx = { ...(await seedProject()), now: NOW }
    const shard = (
      idempotencyKey: string,
      shardIndex: number,
      executions: IngestRunBatch['executions'],
    ): IngestRunBatch => ({
      contractVersion: '0.1.0',
      idempotencyKey,
      resource: {
        ciProvider: 'github_actions',
        ciRunId: '555',
        commitSha: 'abc1234',
        branch: 'main',
        trigger: 'push',
        shardIndex,
        shardTotal: 2,
      },
      run: { status: 'failed', startedAt: new Date('2026-07-16T10:00:00Z') },
      executions,
    })

    await processJob(
      prisma,
      shard('ci-555-1-shard2', 2, [
        {
          filePath: 'e2e/b.spec.ts',
          suite: 's',
          title: 'Y',
          status: 'fail',
          attempt: 1,
          startedAt: new Date('2026-07-16T10:00:02Z'),
          durationMs: 100,
          error: { message: 'boom' },
        },
        {
          filePath: 'e2e/c.spec.ts',
          suite: 's',
          title: 'Z',
          status: 'fail',
          attempt: 1,
          startedAt: new Date('2026-07-16T10:00:03Z'),
          durationMs: 100,
          error: { message: 'boom' },
        },
      ]),
      ctx,
    )

    await processJob(
      prisma,
      shard('ci-555-1-shard1', 1, [
        {
          filePath: 'e2e/a.spec.ts',
          suite: 's',
          title: 'X',
          status: 'fail',
          attempt: 1,
          startedAt: new Date('2026-07-16T10:00:01Z'),
          durationMs: 100,
          error: { message: 'boom' },
        },
      ]),
      ctx,
    )

    const x = await prisma.testIdentity.findFirstOrThrow({ where: { title: 'X' } })
    const score = await prisma.flakyScore.findUniqueOrThrow({ where: { testIdentityId: x.id } })
    expect(score.failIsolation).toBe(0)

    const runs = await prisma.run.findMany({
      where: { ciRunId: '555' },
      select: { shardIndex: true },
    })
    expect(runs).toHaveLength(2)
  })

  it('auto-quarantines a flaky candidate when the policy enables it', async () => {
    const ctx = {
      ...(await seedProject()),
      now: NOW,
      threshold: 0.01,
      minSamples: 1,
      quarantineEnabled: true,
    }
    await processJob(prisma, batch(), ctx)

    const identity = await prisma.testIdentity.findFirstOrThrow()
    expect(identity.quarantined).toBe(true)
    expect(identity.quarantineReason).toContain('auto')
  })

  it('does not quarantine when the policy leaves it disabled', async () => {
    const ctx = { ...(await seedProject()), now: NOW, threshold: 0.01, minSamples: 1 }
    await processJob(prisma, batch(), ctx)

    const identity = await prisma.testIdentity.findFirstOrThrow()
    expect(identity.quarantined).toBe(false)
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

    const stitch = await prisma.identityStitch.findFirstOrThrow({
      where: { testIdentityId: identity.id },
    })
    expect(stitch.level).toBe('L2')
    expect(stitch.fromFilePath).toBe('e2e/login.spec.ts')
    expect(stitch.toFilePath).toBe('e2e/auth/login.spec.ts')
    expect(stitch.confidence).toBeNull()
    expect(stitch.fromFingerprint).toBe(identity.aliases[0])
  })

  it('does not rename onto a test that is still running in the same batch', async () => {
    const ctx = { ...(await seedProject()), now: NOW }
    await processJob(prisma, batch(), ctx)

    const both = batch({
      idempotencyKey: 'run-000004',
      executions: [
        {
          filePath: 'e2e/login.spec.ts',
          suite: 'auth',
          title: 'logs in',
          status: 'pass',
          attempt: 1,
          startedAt: new Date('2026-07-16T12:00:00Z'),
          durationMs: 1000,
        },
        {
          filePath: 'e2e/login.spec.ts',
          suite: 'auth',
          title: 'logs in successfully',
          status: 'pass',
          attempt: 1,
          startedAt: new Date('2026-07-16T12:00:01Z'),
          durationMs: 1100,
        },
      ],
    })
    const result = await processJob(prisma, both, ctx)

    // The original test is still in the run, so the new title is a genuinely new
    // test rather than a rename of it.
    expect(result.movedIdentities).toBe(0)
    expect(result.newIdentities).toBe(1)
    expect(await prisma.testIdentity.count()).toBe(2)
  })

  it('records an L3 rename stitch with a confidence score', async () => {
    const ctx = { ...(await seedProject()), now: NOW }
    await processJob(prisma, batch(), ctx)

    const renamed = batch({
      idempotencyKey: 'run-000003',
      executions: [
        {
          filePath: 'e2e/login.spec.ts',
          suite: 'auth',
          title: 'logs in successfully',
          status: 'pass',
          attempt: 1,
          startedAt: new Date('2026-07-16T11:30:00Z'),
          durationMs: 1500,
        },
      ],
    })
    const result = await processJob(prisma, renamed, ctx)

    expect(result.movedIdentities).toBe(1)
    expect(await prisma.testIdentity.count()).toBe(1)

    const identity = await prisma.testIdentity.findFirstOrThrow()
    expect(identity.title).toBe('logs in successfully')

    const stitch = await prisma.identityStitch.findFirstOrThrow({
      where: { testIdentityId: identity.id },
    })
    expect(stitch.level).toBe('L3')
    expect(stitch.fromTitle).toBe('logs in')
    expect(stitch.toTitle).toBe('logs in successfully')
    expect(stitch.confidence).not.toBeNull()
    expect(stitch.confidence!).toBeGreaterThan(0.5)
  })
})
