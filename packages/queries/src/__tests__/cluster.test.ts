import { PrismaClient } from '@flakemetry/db'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'

import { getClusterImpact } from '../cluster'

const hasDb = Boolean(process.env.DATABASE_URL)
const prisma = new PrismaClient()

interface Seed {
  projectId: string
  execA: string
  execUnclustered: string
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

  const clusterId = '11111111-1111-1111-1111-111111111111'
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

  return { projectId: project.id, execA, execUnclustered }
}

describe.skipIf(!hasDb)('getClusterImpact', () => {
  beforeEach(async () => {
    await prisma.testExecution.deleteMany()
    await prisma.errorSignature.deleteMany()
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
    expect(impact?.tests.map((test) => test.title)).toEqual(['B'])
  })

  it('returns null when the execution signature has no cluster', async () => {
    const s = await seed()
    expect(await getClusterImpact(prisma, s.projectId, s.execUnclustered)).toBeNull()
  })
})
