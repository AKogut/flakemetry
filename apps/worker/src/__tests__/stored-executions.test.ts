import type { IngestRunBatch } from '@flakemetry/contracts'
import { createPrismaClient, storedExecutionCount } from '@flakemetry/db'
import { eraseTarget, mergeIdentities, unmergeIdentity } from '@flakemetry/queries'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'

import { processJob } from '../processor'
import { capRawExecutions } from '../retention'
import { pruneRawExecutions } from '../rollups'

const hasDb = Boolean(process.env.DATABASE_URL)
const prisma = createPrismaClient()

const NOW = new Date('2026-07-20T12:00:00Z')

const batch = (key: string, startedAt: string, titles: string[]): IngestRunBatch => ({
  contractVersion: '0.1.0',
  idempotencyKey: key,
  resource: { ciProvider: 'github_actions', commitSha: 'abc1234', branch: 'main', trigger: 'push' },
  run: { status: 'passed', startedAt: new Date(startedAt) },
  executions: titles.map((title, index) => ({
    filePath: 'e2e/app.spec.ts',
    suite: 'app',
    title,
    status: 'pass',
    attempt: 1,
    startedAt: new Date(new Date(startedAt).getTime() + index * 1000),
    durationMs: 500,
  })),
})

describe.skipIf(!hasDb)('the stored execution count', () => {
  let orgId = ''
  let projectId = ''

  const counted = () => prisma.testExecution.count({ where: { projectId } })
  const expectInStep = async () => {
    expect(await storedExecutionCount(prisma, projectId)).toBe(await counted())
  }

  beforeEach(async () => {
    await prisma.testExecution.deleteMany()
    await prisma.run.deleteMany()
    await prisma.testIdentity.deleteMany()
    await prisma.project.deleteMany()
    await prisma.org.deleteMany()
    const org = await prisma.org.create({ data: { name: 'Acme', slug: `acme-${Date.now()}` } })
    const project = await prisma.project.create({
      data: { orgId: org.id, name: 'Web', slug: 'web' },
    })
    orgId = org.id
    projectId = project.id
  })

  afterAll(async () => {
    await prisma.$disconnect()
  })

  it('follows every way executions are added, moved and removed', async () => {
    const ctx = { orgId, projectId, now: NOW }

    await processJob(prisma, batch('old', '2026-06-01T10:00:00Z', ['a', 'b', 'c']), ctx)
    await processJob(prisma, batch('mid', '2026-07-10T10:00:00Z', ['a', 'b', 'c', 'd']), ctx)
    await processJob(prisma, batch('new', '2026-07-19T10:00:00Z', ['a', 'b']), ctx)
    expect(await counted()).toBe(9)
    await expectInStep()

    await processJob(prisma, batch('mid', '2026-07-10T10:00:00Z', ['a', 'b']), ctx)
    expect(await counted()).toBe(7)
    await expectInStep()

    const [a, b] = await Promise.all([
      prisma.testIdentity.findFirstOrThrow({ where: { projectId, title: 'a' } }),
      prisma.testIdentity.findFirstOrThrow({ where: { projectId, title: 'b' } }),
    ])
    expect(
      await mergeIdentities(prisma, {
        orgId,
        projectId,
        targetIdentityId: a.id,
        sourceIdentityId: b.id,
      }),
    ).toMatchObject({ status: 'merged' })
    await expectInStep()
    await unmergeIdentity(prisma, { orgId, projectId, targetIdentityId: a.id })
    await expectInStep()

    expect(await pruneRawExecutions(prisma, { olderThanDays: 30, projectId, now: NOW })).toBe(3)
    expect(await counted()).toBe(4)
    await expectInStep()

    await processJob(prisma, batch('old', '2026-06-01T10:00:00Z', ['a', 'b', 'c']), ctx)
    await expectInStep()

    expect(await capRawExecutions(prisma, projectId, 5)).toBe(2)
    expect(await counted()).toBe(5)
    await expectInStep()

    const outcome = await eraseTarget(prisma, null, {
      kind: 'project',
      id: projectId,
      orgId,
      artifactPrefix: `org/${orgId}/project/${projectId}/`,
    })
    expect(outcome.verified).toBe(true)
    expect(await storedExecutionCount(prisma, projectId)).toBe(0)
  })

  it('prunes by age across projects without touching another project count', async () => {
    const other = await prisma.project.create({ data: { orgId, name: 'Api', slug: 'api' } })
    await processJob(prisma, batch('old', '2026-06-01T10:00:00Z', ['a', 'b']), {
      orgId,
      projectId,
      now: NOW,
    })
    await processJob(prisma, batch('recent', '2026-07-19T10:00:00Z', ['a']), {
      orgId,
      projectId: other.id,
      now: NOW,
    })

    expect(await pruneRawExecutions(prisma, { olderThanDays: 30, now: NOW })).toBe(2)

    expect(await storedExecutionCount(prisma, projectId)).toBe(0)
    expect(await storedExecutionCount(prisma, other.id)).toBe(1)
    expect(await prisma.testExecution.count({ where: { projectId: other.id } })).toBe(1)
  })
})
