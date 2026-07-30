import type { PrismaClient } from '@flakemetry/db'

export interface ClusterImpactTest {
  testIdentityId: string
  title: string
  suite: string
  filePath: string
}

export interface ClusterImpact {
  clusterId: string
  signatureCount: number
  occurrenceCount: number
  tests: ClusterImpactTest[]
}

const RELATED_TEST_LIMIT = 25

export const getClusterImpact = async (
  prisma: PrismaClient,
  projectId: string,
  executionId: string,
): Promise<ClusterImpact | null> => {
  const execution = await prisma.testExecution.findFirst({
    where: { id: executionId, projectId },
    select: { testIdentityId: true, errorSignature: { select: { clusterId: true } } },
  })
  const clusterId = execution?.errorSignature?.clusterId
  if (!clusterId) return null

  const siblings = await prisma.errorSignature.findMany({
    where: { projectId, clusterId },
    select: { id: true, occurrenceCount: true },
  })
  const signatureIds = siblings.map((sibling) => sibling.id)
  const occurrenceCount = siblings.reduce((sum, sibling) => sum + sibling.occurrenceCount, 0)

  const relatedTests = await prisma.testExecution.findMany({
    where: {
      projectId,
      errorSignatureId: { in: signatureIds },
      testIdentityId: { not: execution.testIdentityId },
    },
    distinct: ['testIdentityId'],
    orderBy: { startedAt: 'desc' },
    take: RELATED_TEST_LIMIT,
    select: {
      testIdentityId: true,
      identity: { select: { title: true, suite: true, filePath: true } },
    },
  })
  if (relatedTests.length === 0) return null

  return {
    clusterId,
    signatureCount: siblings.length,
    occurrenceCount,
    tests: relatedTests.map((row) => ({
      testIdentityId: row.testIdentityId,
      title: row.identity.title,
      suite: row.identity.suite,
      filePath: row.identity.filePath,
    })),
  }
}
