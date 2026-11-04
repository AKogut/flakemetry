import { createPrismaClient } from '@flakemetry/db'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'

import { getClusterImpact } from '../cluster'

const hasDb = Boolean(process.env.DATABASE_URL)
const prisma = createPrismaClient()

interface Seed {
  projectId: string
  execA: string
  execUnclustered: string
  addFailure: (options: {
    title: string
    ciRunId: string | null
    signature: 'a' | 'b'
    onOwnRun?: boolean
  }) => Promise<void>
  ownRunExecution: string
}

const seed = async (): Promise<Seed> => {
  const org = await prisma.org.create({ data: { name: 'Acme', slug: `acme-${Date.now()}` } })
  const project = await prisma.project.create({
    data: { orgId: org.id, name: 'Web', slug: 'web' },
  })
  const tenant = { orgId: org.id, projectId: project.id }

  const testA = await prisma.testIdentity.create({
    data: { ...tenant, fingerprint: 'fp-a', filePath: 'a.spec.ts', suite: 's', title: 'A' },
  })
  const testB = await prisma.testIdentity.create({
    data: { ...tenant, fingerprint: 'fp-b', filePath: 'b.spec.ts', suite: 's', title: 'B' },
  })
  const testC = await prisma.testIdentity.create({
    data: { ...tenant, fingerprint: 'fp-c', filePath: 'c.spec.ts', suite: 's', title: 'C' },
  })

  const cluster = await prisma.errorCluster.create({
    data: { ...tenant, label: 'boom' },
    select: { id: true },
  })
  const clusterId = cluster.id
  const sigA = await prisma.errorSignature.create({
    data: {
      ...tenant,
      normalizedHash: 'h-a',
      sampleMessage: 'boom',
      stackTemplate: 't',
      clusterId,
      occurrenceCount: 3,
    },
  })
  const sigB = await prisma.errorSignature.create({
    data: {
      ...tenant,
      normalizedHash: 'h-b',
      sampleMessage: 'boom2',
      stackTemplate: 't',
      clusterId,
      occurrenceCount: 2,
    },
  })
  const sigLone = await prisma.errorSignature.create({
    data: {
      ...tenant,
      normalizedHash: 'h-c',
      sampleMessage: 'other',
      stackTemplate: 't',
      clusterId: null,
      occurrenceCount: 1,
    },
  })

  const run = await prisma.run.create({
    data: {
      ...tenant,
      idempotencyKey: 'r1',
      commitSha: 'abc',
      branch: 'main',
      ciProvider: 'github_actions',
      ciRunId: 'ci-1',
      trigger: 'push',
      status: 'failed',
      startedAt: new Date('2026-07-16T10:00:00Z'),
    },
  })

  const exec = async (
    ordinal: number,
    testIdentityId: string,
    errorSignatureId: string,
  ): Promise<string> => {
    const row = await prisma.testExecution.create({
      data: {
        ...tenant,
        runId: run.id,
        ordinal,
        testIdentityId,
        errorSignatureId,
        attempt: 1,
        status: 'fail',
        durationMs: 100,
        startedAt: new Date(`2026-07-16T10:00:0${ordinal}Z`),
      },
    })
    return row.id
  }

  const execA = await exec(0, testA.id, sigA.id)
  await exec(1, testB.id, sigB.id)
  const execUnclustered = await exec(2, testC.id, sigLone.id)

  let extra = 0
  const insertFailure = async (
    title: string,
    ciRunId: string | null,
    signature: 'a' | 'b',
  ): Promise<string> => {
    extra += 1
    const identity = await prisma.testIdentity.create({
      data: { ...tenant, fingerprint: `fp-x${extra}`, filePath: 'x.spec.ts', suite: 's', title },
    })
    const otherRun = await prisma.run.create({
      data: {
        ...tenant,
        idempotencyKey: `extra-${extra}`,
        commitSha: 'def',
        branch: 'main',
        ciProvider: 'github_actions',
        ciRunId,
        trigger: 'push',
        status: 'failed',
        startedAt: new Date('2026-07-17T10:00:00Z'),
      },
    })
    const row = await prisma.testExecution.create({
      data: {
        ...tenant,
        runId: otherRun.id,
        ordinal: 0,
        testIdentityId: identity.id,
        errorSignatureId: signature === 'a' ? sigA.id : sigB.id,
        attempt: 1,
        status: 'fail',
        durationMs: 100,
        startedAt: new Date('2026-07-17T10:00:01Z'),
      },
    })
    return row.id
  }

  const ownRunExecution = await insertFailure('own run', null, 'a')

  return {
    projectId: project.id,
    execA,
    execUnclustered,
    ownRunExecution,
    addFailure: async ({ title, ciRunId, signature }) => {
      await insertFailure(title, ciRunId, signature)
    },
  }
}

describe.skipIf(!hasDb)('getClusterImpact', () => {
  beforeEach(async () => {
    await prisma.testExecution.deleteMany()
    await prisma.errorSignature.deleteMany()
    await prisma.errorCluster.deleteMany()
    await prisma.testIdentity.deleteMany()
    await prisma.run.deleteMany()
    await prisma.project.deleteMany()
    await prisma.org.deleteMany()
  })

  afterAll(async () => {
    await prisma.$disconnect()
  })

  it('reports other tests that share the failure cluster with pooled occurrences', async () => {
    const s = await seed()
    const impact = await getClusterImpact(prisma, s.projectId, s.execA)

    expect(impact).not.toBeNull()
    expect(impact?.signatureCount).toBe(2)
    expect(impact?.occurrenceCount).toBe(5)
    expect(impact?.tests.map((test) => test.title).sort()).toEqual(['B', 'own run'])
  })

  it('tells failures in the same run apart from ones that only share the error text', async () => {
    const s = await seed()
    await s.addFailure({ title: 'other night', ciRunId: 'ci-2', signature: 'b' })

    const impact = await getClusterImpact(prisma, s.projectId, s.execA)

    expect(impact?.sameRunTestCount).toBe(1)
    expect(
      Object.fromEntries(impact?.tests.map((test) => [test.title, test.failedInSameRun]) ?? []),
    ).toEqual({ B: true, 'other night': false, 'own run': false })
  })

  it('treats the jobs of one CI run as one run', async () => {
    const s = await seed()
    await s.addFailure({ title: 'other job', ciRunId: 'ci-1', signature: 'a' })

    const impact = await getClusterImpact(prisma, s.projectId, s.execA)

    expect(impact?.sameRunTestCount).toBe(2)
    expect(impact?.tests.find((test) => test.title === 'other job')?.failedInSameRun).toBe(true)
  })

  it('finds no shared run for a failure with no CI run id and no peer in its own run', async () => {
    const s = await seed()

    const impact = await getClusterImpact(prisma, s.projectId, s.ownRunExecution)

    expect(impact?.sameRunTestCount).toBe(0)
    expect(impact?.tests.every((test) => !test.failedInSameRun)).toBe(true)
  })

  it('returns null when the execution signature has no cluster', async () => {
    const s = await seed()
    expect(await getClusterImpact(prisma, s.projectId, s.execUnclustered)).toBeNull()
  })
})
