import { PrismaClient } from '@flakemetry/db'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'

import { mergeIdentities, splitIdentity, unmergeIdentity } from '../identity'

const hasDb = Boolean(process.env.DATABASE_URL)
const prisma = new PrismaClient()

const BEFORE = new Date('2026-07-10T10:00:00Z')
const AFTER = new Date('2026-07-20T10:00:00Z')
const ALIAS = 'sha256:renamed-fingerprint'

const seed = async () => {
  const org = await prisma.org.create({ data: { name: 'Acme', slug: `acme-${Date.now()}` } })
  const project = await prisma.project.create({ data: { orgId: org.id, name: 'Web', slug: 'web' } })
  const tenant = { orgId: org.id, projectId: project.id }

  const identity = await prisma.testIdentity.create({
    data: {
      ...tenant,
      fingerprint: 'sha256:original',
      filePath: 'e2e/login.spec.ts',
      suite: 'auth',
      title: 'logs in successfully',
      aliases: [ALIAS],
      firstSeenAt: BEFORE,
      lastSeenAt: AFTER,
    },
  })

  await prisma.identityStitch.create({
    data: {
      ...tenant,
      testIdentityId: identity.id,
      level: 'L3',
      fromFingerprint: ALIAS,
      fromFilePath: 'e2e/login.spec.ts',
      fromTitle: 'logs in',
      toFilePath: 'e2e/login.spec.ts',
      toTitle: 'logs in successfully',
      confidence: 0.6,
      runStartedAt: AFTER,
    },
  })

  const makeRun = async (key: string, startedAt: Date) =>
    prisma.run.create({
      data: {
        ...tenant,
        idempotencyKey: key,
        commitSha: 'abc1234',
        branch: 'main',
        ciProvider: 'github_actions',
        trigger: 'push',
        status: 'passed',
        startedAt,
      },
    })

  const runBefore = await makeRun('run-before', BEFORE)
  const runAfter = await makeRun('run-after', AFTER)

  await prisma.testExecution.create({
    data: {
      ...tenant,
      runId: runBefore.id,
      ordinal: 0,
      testIdentityId: identity.id,
      status: 'pass',
      attempt: 1,
      durationMs: 1000,
      startedAt: BEFORE,
    },
  })
  await prisma.testExecution.create({
    data: {
      ...tenant,
      runId: runAfter.id,
      ordinal: 0,
      testIdentityId: identity.id,
      status: 'fail',
      attempt: 1,
      durationMs: 1200,
      startedAt: AFTER,
    },
  })

  return { orgId: org.id, projectId: project.id, identityId: identity.id }
}

describe.skipIf(!hasDb)('splitIdentity', () => {
  beforeEach(async () => {
    await prisma.identityChange.deleteMany()
    await prisma.identityStitch.deleteMany()
    await prisma.testHealthEvent.deleteMany()
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

  it('splits post-stitch executions into a new identity and reverts the source title', async () => {
    const s = await seed()

    const outcome = await splitIdentity(prisma, {
      orgId: s.orgId,
      projectId: s.projectId,
      sourceIdentityId: s.identityId,
      fingerprint: ALIAS,
    })

    expect(outcome.status).toBe('split')
    if (outcome.status !== 'split') return
    expect(outcome.movedExecutions).toBe(1)

    const source = await prisma.testIdentity.findUniqueOrThrow({ where: { id: s.identityId } })
    expect(source.title).toBe('logs in')
    expect(source.aliases).toEqual([])

    const target = await prisma.testIdentity.findUniqueOrThrow({
      where: { id: outcome.targetIdentityId },
    })
    expect(target.fingerprint).toBe(ALIAS)
    expect(target.title).toBe('logs in successfully')

    const sourceExecutions = await prisma.testExecution.count({
      where: { testIdentityId: s.identityId },
    })
    const targetExecutions = await prisma.testExecution.count({
      where: { testIdentityId: outcome.targetIdentityId },
    })
    expect(sourceExecutions).toBe(1)
    expect(targetExecutions).toBe(1)

    expect(await prisma.identityStitch.count()).toBe(0)

    const audit = await prisma.identityChange.findFirstOrThrow()
    expect(audit.action).toBe('split')
    expect(audit.fingerprint).toBe(ALIAS)

    const scores = await prisma.flakyScore.count()
    expect(scores).toBe(2)

    const sourceDaily = await prisma.dailyTestStats.findMany({
      where: { testIdentityId: s.identityId },
    })
    expect(sourceDaily).toHaveLength(1)
    expect(sourceDaily[0]?.passed).toBe(1)
  })

  it('rejects a fingerprint that is not stitched into the test', async () => {
    const s = await seed()
    const outcome = await splitIdentity(prisma, {
      orgId: s.orgId,
      projectId: s.projectId,
      sourceIdentityId: s.identityId,
      fingerprint: 'sha256:unknown',
    })
    expect(outcome.status).toBe('rejected')
  })
})

describe.skipIf(!hasDb)('mergeIdentities', () => {
  beforeEach(async () => {
    await prisma.identityChange.deleteMany()
    await prisma.identityStitch.deleteMany()
    await prisma.testHealthEvent.deleteMany()
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

  const seedPair = async () => {
    const org = await prisma.org.create({ data: { name: 'Acme', slug: `acme-${Date.now()}` } })
    const project = await prisma.project.create({
      data: { orgId: org.id, name: 'Web', slug: 'web' },
    })
    const tenant = { orgId: org.id, projectId: project.id }

    const makeIdentity = (fingerprint: string, title: string, seen: Date) =>
      prisma.testIdentity.create({
        data: {
          ...tenant,
          fingerprint,
          filePath: 'e2e/login.spec.ts',
          suite: 'auth',
          title,
          firstSeenAt: seen,
          lastSeenAt: seen,
        },
      })

    const target = await makeIdentity('sha256:new', 'logs in successfully', AFTER)
    const source = await makeIdentity('sha256:old', 'logs in', BEFORE)

    const run = await prisma.run.create({
      data: {
        ...tenant,
        idempotencyKey: 'run-merge',
        commitSha: 'abc1234',
        branch: 'main',
        ciProvider: 'github_actions',
        trigger: 'push',
        status: 'passed',
        startedAt: BEFORE,
      },
    })
    await prisma.testExecution.create({
      data: {
        ...tenant,
        runId: run.id,
        ordinal: 0,
        testIdentityId: source.id,
        status: 'pass',
        attempt: 1,
        durationMs: 1000,
        startedAt: BEFORE,
      },
    })

    return { orgId: org.id, projectId: project.id, targetId: target.id, sourceId: source.id }
  }

  it('folds the source history into the target and consumes the source identity', async () => {
    const s = await seedPair()

    const outcome = await mergeIdentities(prisma, {
      orgId: s.orgId,
      projectId: s.projectId,
      targetIdentityId: s.targetId,
      sourceIdentityId: s.sourceId,
    })

    expect(outcome.status).toBe('merged')
    if (outcome.status !== 'merged') return
    expect(outcome.movedExecutions).toBe(1)

    expect(await prisma.testIdentity.findUnique({ where: { id: s.sourceId } })).toBeNull()

    const target = await prisma.testIdentity.findUniqueOrThrow({ where: { id: s.targetId } })
    expect(target.aliases).toContain('sha256:old')
    expect(target.firstSeenAt.getTime()).toBe(BEFORE.getTime())

    expect(await prisma.testExecution.count({ where: { testIdentityId: s.targetId } })).toBe(1)

    const stitch = await prisma.identityStitch.findFirstOrThrow()
    expect(stitch.level).toBe('manual')
    expect(stitch.testIdentityId).toBe(s.targetId)

    const audit = await prisma.identityChange.findFirstOrThrow()
    expect(audit.action).toBe('merge')

    expect(await prisma.flakyScore.count({ where: { testIdentityId: s.targetId } })).toBe(1)
  })

  it('rejects merging a test into itself', async () => {
    const s = await seedPair()
    const outcome = await mergeIdentities(prisma, {
      orgId: s.orgId,
      projectId: s.projectId,
      targetIdentityId: s.targetId,
      sourceIdentityId: s.targetId,
    })
    expect(outcome.status).toBe('rejected')
  })

  it('refuses to merge different parameterized cases', async () => {
    const s = await seedPair()
    await prisma.testIdentity.update({
      where: { id: s.sourceId },
      data: { paramsHash: 'abc123' },
    })
    const outcome = await mergeIdentities(prisma, {
      orgId: s.orgId,
      projectId: s.projectId,
      targetIdentityId: s.targetId,
      sourceIdentityId: s.sourceId,
    })
    expect(outcome.status).toBe('rejected')
  })
})

describe.skipIf(!hasDb)('unmergeIdentity', () => {
  beforeEach(async () => {
    await prisma.identityMerge.deleteMany()
    await prisma.identityChange.deleteMany()
    await prisma.identityStitch.deleteMany()
    await prisma.testHealthEvent.deleteMany()
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

  const seedMerged = async () => {
    const org = await prisma.org.create({ data: { name: 'Acme', slug: `acme-${Date.now()}` } })
    const project = await prisma.project.create({
      data: { orgId: org.id, name: 'Web', slug: 'web' },
    })
    const tenant = { orgId: org.id, projectId: project.id }

    const makeIdentity = (fingerprint: string, title: string, seen: Date) =>
      prisma.testIdentity.create({
        data: {
          ...tenant,
          fingerprint,
          filePath: 'e2e/login.spec.ts',
          suite: 'auth',
          title,
          firstSeenAt: seen,
          lastSeenAt: seen,
        },
      })

    const target = await makeIdentity('sha256:new', 'logs in successfully', AFTER)
    const source = await makeIdentity('sha256:old', 'logs in', BEFORE)

    const run = await prisma.run.create({
      data: {
        ...tenant,
        idempotencyKey: 'run-unmerge',
        commitSha: 'abc1234',
        branch: 'main',
        ciProvider: 'github_actions',
        trigger: 'push',
        status: 'passed',
        startedAt: BEFORE,
      },
    })

    const execute = (identityId: string, ordinal: number, startedAt: Date) =>
      prisma.testExecution.create({
        data: {
          ...tenant,
          runId: run.id,
          ordinal,
          testIdentityId: identityId,
          status: 'pass',
          attempt: 1,
          durationMs: 1000,
          startedAt,
        },
      })

    await execute(source.id, 0, BEFORE)
    await execute(target.id, 1, AFTER)

    await mergeIdentities(prisma, {
      orgId: org.id,
      projectId: project.id,
      targetIdentityId: target.id,
      sourceIdentityId: source.id,
    })

    return { orgId: org.id, projectId: project.id, targetId: target.id, sourceId: source.id }
  }

  it('restores the consumed identity with exactly the executions it contributed', async () => {
    const s = await seedMerged()
    expect(await prisma.testExecution.count({ where: { testIdentityId: s.targetId } })).toBe(2)

    const outcome = await unmergeIdentity(prisma, {
      orgId: s.orgId,
      projectId: s.projectId,
      targetIdentityId: s.targetId,
    })

    expect(outcome.status).toBe('unmerged')
    if (outcome.status !== 'unmerged') return
    expect(outcome.restoredExecutions).toBe(1)

    const restored = await prisma.testIdentity.findUniqueOrThrow({
      where: { id: outcome.restoredIdentityId },
    })
    expect(restored.fingerprint).toBe('sha256:old')
    expect(restored.title).toBe('logs in')
    expect(restored.suite).toBe('auth')

    // Each identity gets its own execution back, and nothing is left marked.
    expect(await prisma.testExecution.count({ where: { testIdentityId: restored.id } })).toBe(1)
    expect(await prisma.testExecution.count({ where: { testIdentityId: s.targetId } })).toBe(1)
    expect(
      await prisma.testExecution.count({ where: { mergedFromIdentityId: { not: null } } }),
    ).toBe(0)

    // The alias handed over by the merge is given back, and the merge stitch is gone.
    const target = await prisma.testIdentity.findUniqueOrThrow({ where: { id: s.targetId } })
    expect(target.aliases).not.toContain('sha256:old')
    expect(await prisma.identityStitch.count({ where: { level: 'manual' } })).toBe(0)

    // Both sides are rescored and the undo is audited.
    expect(await prisma.flakyScore.count({ where: { testIdentityId: restored.id } })).toBe(1)
    const audit = await prisma.identityChange.findFirstOrThrow({ where: { action: 'unmerge' } })
    expect(audit.fingerprint).toBe('sha256:old')
  })

  it('refuses a second undo once the merge is already undone', async () => {
    const s = await seedMerged()
    const first = await unmergeIdentity(prisma, {
      orgId: s.orgId,
      projectId: s.projectId,
      targetIdentityId: s.targetId,
    })
    expect(first.status).toBe('unmerged')

    const second = await unmergeIdentity(prisma, {
      orgId: s.orgId,
      projectId: s.projectId,
      targetIdentityId: s.targetId,
    })
    expect(second.status).toBe('rejected')
  })

  it('refuses to undo when the merged-in fingerprint exists again', async () => {
    const s = await seedMerged()
    await prisma.testIdentity.create({
      data: {
        orgId: s.orgId,
        projectId: s.projectId,
        fingerprint: 'sha256:old',
        filePath: 'e2e/login.spec.ts',
        suite: 'auth',
        title: 'logs in',
        firstSeenAt: BEFORE,
        lastSeenAt: BEFORE,
      },
    })

    const outcome = await unmergeIdentity(prisma, {
      orgId: s.orgId,
      projectId: s.projectId,
      targetIdentityId: s.targetId,
    })
    expect(outcome.status).toBe('rejected')
  })
})

describe.skipIf(!hasDb)('unmergeIdentity with nested merges', () => {
  beforeEach(async () => {
    await prisma.identityMerge.deleteMany()
    await prisma.identityChange.deleteMany()
    await prisma.identityStitch.deleteMany()
    await prisma.testHealthEvent.deleteMany()
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

  it('gives back a merge the source had itself absorbed instead of destroying it', async () => {
    const org = await prisma.org.create({ data: { name: 'Acme', slug: `acme-${Date.now()}` } })
    const project = await prisma.project.create({
      data: { orgId: org.id, name: 'Web', slug: 'web' },
    })
    const tenant = { orgId: org.id, projectId: project.id }

    const make = (fingerprint: string, title: string) =>
      prisma.testIdentity.create({
        data: {
          ...tenant,
          fingerprint,
          filePath: 'e2e/login.spec.ts',
          suite: 'auth',
          title,
          firstSeenAt: BEFORE,
          lastSeenAt: BEFORE,
        },
      })

    const a = await make('sha256:a', 'logs in v3')
    const b = await make('sha256:b', 'logs in v2')
    const c = await make('sha256:c', 'logs in v1')

    // c is folded into b, then b into a.
    const first = await mergeIdentities(prisma, {
      orgId: org.id,
      projectId: project.id,
      targetIdentityId: b.id,
      sourceIdentityId: c.id,
    })
    expect(first.status).toBe('merged')

    const second = await mergeIdentities(prisma, {
      orgId: org.id,
      projectId: project.id,
      targetIdentityId: a.id,
      sourceIdentityId: b.id,
    })
    expect(second.status).toBe('merged')
    expect(await prisma.identityStitch.count({ where: { level: 'manual' } })).toBe(2)

    const undone = await unmergeIdentity(prisma, {
      orgId: org.id,
      projectId: project.id,
      targetIdentityId: a.id,
    })
    expect(undone.status).toBe('unmerged')
    if (undone.status !== 'unmerged') return

    // Only the a←b merge is undone. The record that b had absorbed c survives,
    // and travels back to the restored b rather than being deleted with it.
    const remaining = await prisma.identityStitch.findMany({ where: { level: 'manual' } })
    expect(remaining).toHaveLength(1)
    expect(remaining[0]?.fromFingerprint).toBe('sha256:c')
    expect(remaining[0]?.testIdentityId).toBe(undone.restoredIdentityId)
  })
})
