import type { ReasonCode, TestDetail } from '@flakemetry/contracts'
import type { PrismaClient } from '@flakemetry/db'

export const getTest = async (
  prisma: PrismaClient,
  projectId: string,
  testIdentityId: string,
  historyLimit: number,
): Promise<TestDetail | null> => {
  const identity = await prisma.testIdentity.findFirst({
    where: { id: testIdentityId, projectId },
    select: {
      id: true,
      fingerprint: true,
      filePath: true,
      suite: true,
      title: true,
      quarantined: true,
      flakyScore: { select: { score: true, reasonCodes: true } },
    },
  })
  if (!identity) return null

  const executions = await prisma.testExecution.findMany({
    where: { testIdentityId, projectId },
    orderBy: { startedAt: 'desc' },
    take: historyLimit,
    select: {
      id: true,
      status: true,
      attempt: true,
      durationMs: true,
      startedAt: true,
      errorMessage: true,
      run: { select: { id: true, commitSha: true, branch: true } },
      rcaReport: { select: { id: true } },
    },
  })

  const reasonCodes = (identity.flakyScore?.reasonCodes ?? []) as ReasonCode[]

  return {
    id: identity.id,
    fingerprint: identity.fingerprint,
    filePath: identity.filePath,
    suite: identity.suite,
    title: identity.title,
    quarantined: identity.quarantined,
    score: identity.flakyScore?.score ?? null,
    reasonCodes,
    history: executions
      .map((execution) => ({
        executionId: execution.id,
        runId: execution.run.id,
        commitSha: execution.run.commitSha,
        branch: execution.run.branch,
        startedAt: execution.startedAt,
        status: execution.status,
        attempt: execution.attempt,
        durationMs: execution.durationMs,
        errorMessage: execution.errorMessage,
        hasRca: execution.rcaReport !== null,
      }))
      .reverse(),
  }
}
