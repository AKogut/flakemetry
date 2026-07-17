import type { RcaGetResult, RcaSimilarPast } from '@flakemetry/contracts'
import type { PrismaClient } from '@flakemetry/db'

export const getRca = async (
  prisma: PrismaClient,
  projectId: string,
  executionId: string,
): Promise<RcaGetResult> => {
  const report = await prisma.rcaReport.findFirst({
    where: { executionId, projectId },
    select: {
      id: true,
      projectId: true,
      executionId: true,
      signatureId: true,
      summary: true,
      likelyCause: true,
      suggestedAction: true,
      confidence: true,
      similarPast: true,
      llmModel: true,
      tokenCost: true,
      createdAt: true,
    },
  })
  if (!report) return null

  return {
    ...report,
    similarPast: report.similarPast as RcaSimilarPast[],
  }
}
