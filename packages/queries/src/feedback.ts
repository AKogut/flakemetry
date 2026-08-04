import type { EvalCase } from '@flakemetry/ai'
import type { PrismaClient, RcaVerdict } from '@flakemetry/db'

export interface RecordFeedbackParams {
  orgId: string
  projectId: string
  reportId: string
  userId: string
  verdict: RcaVerdict
  correction?: string | null
}

export const recordRcaFeedback = async (
  prisma: PrismaClient,
  params: RecordFeedbackParams,
): Promise<void> => {
  const correction = params.correction?.trim() || null
  const report = await prisma.rcaReport.findFirst({
    where: { id: params.reportId, projectId: params.projectId },
    select: { id: true },
  })
  if (!report) throw new Error('report does not belong to this project')

  await prisma.rcaFeedback.upsert({
    where: { reportId_userId: { reportId: params.reportId, userId: params.userId } },
    create: { ...params, correction },
    update: { verdict: params.verdict, correction },
  })
}

export const getRcaFeedback = async (
  prisma: PrismaClient,
  reportId: string,
  userId: string,
): Promise<{ verdict: RcaVerdict; correction: string | null } | null> =>
  prisma.rcaFeedback.findUnique({
    where: { reportId_userId: { reportId, userId } },
    select: { verdict: true, correction: true },
  })

const keywords = (text: string): string[] => {
  const stop = new Set([
    'the',
    'and',
    'that',
    'this',
    'with',
    'from',
    'for',
    'was',
    'are',
    'its',
    'has',
    'have',
    'when',
    'which',
    'because',
    'should',
    'would',
    'into',
    'than',
    'then',
    'they',
  ])
  return [
    ...new Set(
      text
        .toLowerCase()
        .split(/[^a-z0-9_.-]+/)
        .filter((word) => word.length >= 4 && !stop.has(word)),
    ),
  ].slice(0, 8)
}

/**
 * Turns reviewed reports into eval cases. Only reports carrying a written correction
 * qualify: a bare thumbs-down says an answer was wrong without saying what right looks
 * like, which is not something a score can be computed against.
 */
export const buildEvalSetFromFeedback = async (
  prisma: PrismaClient,
  projectId: string,
  limit = 100,
): Promise<EvalCase[]> => {
  const rows = await prisma.rcaFeedback.findMany({
    where: { projectId, correction: { not: null } },
    orderBy: { createdAt: 'desc' },
    take: limit,
    select: {
      id: true,
      correction: true,
      report: {
        select: {
          summary: true,
          execution: {
            select: {
              errorMessage: true,
              identity: { select: { title: true, suite: true, filePath: true } },
            },
          },
        },
      },
    },
  })

  return rows.flatMap((row) => {
    const execution = row.report.execution
    if (!execution.errorMessage) return []
    const correction = row.correction ?? ''
    return [
      {
        id: row.id,
        input: {
          testTitle: execution.identity.title,
          suite: execution.identity.suite,
          filePath: execution.identity.filePath,
          error: {
            type: null,
            message: execution.errorMessage,
            stack: null,
          },
        },
        expect: { causeKeywords: keywords(correction), actionKeywords: [] },
      },
    ]
  })
}
