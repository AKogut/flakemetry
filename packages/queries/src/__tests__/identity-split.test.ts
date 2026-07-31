import { PrismaClient } from '@flakemetry/db'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'

import { splitIdentity } from '../identity'

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
