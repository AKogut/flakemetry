import type { ArtifactRef, IngestSpan, TestStatus } from '@flakemetry/contracts'
import type { PrismaClient } from '@flakemetry/db'

export interface ExecutionTrace {
  id: string
  testIdentityId: string
  title: string
  suite: string
  filePath: string
  status: TestStatus
  attempt: number
  durationMs: number
  startedAt: Date
  errorMessage: string | null
  commitSha: string
  branch: string
  traceId: string | null
  rootSpanId: string | null
  hasRca: boolean
  spans: IngestSpan[]
  artifacts: ArtifactRef[]
}

export const getExecutionTrace = async (
  prisma: PrismaClient,
  projectId: string,
  executionId: string,
): Promise<ExecutionTrace | null> => {
  const execution = await prisma.testExecution.findFirst({
    where: { id: executionId, projectId },
    select: {
      id: true,
      testIdentityId: true,
      status: true,
      attempt: true,
      durationMs: true,
      startedAt: true,
      errorMessage: true,
      otelTraceId: true,
      otelSpanId: true,
      spans: true,
      artifactsRef: true,
      identity: { select: { title: true, suite: true, filePath: true } },
      run: { select: { commitSha: true, branch: true } },
      rcaReport: { select: { id: true } },
    },
  })
  if (!execution) return null

  return {
    id: execution.id,
    testIdentityId: execution.testIdentityId,
    title: execution.identity.title,
    suite: execution.identity.suite,
    filePath: execution.identity.filePath,
    status: execution.status,
    attempt: execution.attempt,
    durationMs: execution.durationMs,
    startedAt: execution.startedAt,
    errorMessage: execution.errorMessage,
    commitSha: execution.run.commitSha,
    branch: execution.run.branch,
    traceId: execution.otelTraceId,
    rootSpanId: execution.otelSpanId,
    hasRca: execution.rcaReport !== null,
    spans: ((execution.spans as IngestSpan[] | null) ?? []).map((span) => ({
      ...span,
      startedAt: new Date(span.startedAt),
    })),
    artifacts: (execution.artifactsRef ?? []) as ArtifactRef[],
  }
}
