import type {
  ArtifactRef,
  RunCounts,
  RunDetail,
  RunsListInput,
  RunsListResult,
} from '@flakemetry/contracts'
import type { PrismaClient, TestStatus } from '@flakemetry/db'

const emptyCounts = (): RunCounts => ({
  total: 0,
  passed: 0,
  failed: 0,
  skipped: 0,
  flaky: 0,
})

const applyStatus = (counts: RunCounts, status: TestStatus, amount: number): void => {
  counts.total += amount
  if (status === 'pass') counts.passed += amount
  else if (status === 'fail') counts.failed += amount
  else if (status === 'skip') counts.skipped += amount
  else if (status === 'flaky') counts.flaky += amount
}

export const listRuns = async (
  prisma: PrismaClient,
  projectId: string,
  input: RunsListInput,
): Promise<RunsListResult> => {
  const runs = await prisma.run.findMany({
    where: {
      projectId,
      ...(input.branch ? { branch: input.branch } : {}),
      ...(input.status ? { status: input.status } : {}),
      ...(input.since || input.until
        ? {
            startedAt: {
              ...(input.since ? { gte: input.since } : {}),
              ...(input.until ? { lte: input.until } : {}),
            },
          }
        : {}),
    },
    orderBy: [{ startedAt: 'desc' }, { id: 'desc' }],
    take: input.limit + 1,
    ...(input.cursor ? { cursor: { id: input.cursor }, skip: 1 } : {}),
    select: {
      id: true,
      branch: true,
      commitSha: true,
      prNumber: true,
      ciProvider: true,
      status: true,
      startedAt: true,
      durationMs: true,
      passedCount: true,
      failedCount: true,
      skippedCount: true,
      flakyCount: true,
    },
  })

  const page = runs.slice(0, input.limit)
  const nextCursor = runs.length > input.limit ? (page.at(-1)?.id ?? null) : null

  return {
    items: page.map((run) => ({
      id: run.id,
      branch: run.branch,
      commitSha: run.commitSha,
      prNumber: run.prNumber,
      ciProvider: run.ciProvider,
      status: run.status,
      startedAt: run.startedAt,
      durationMs: run.durationMs,
      counts: {
        total: run.passedCount + run.failedCount + run.skippedCount + run.flakyCount,
        passed: run.passedCount,
        failed: run.failedCount,
        skipped: run.skippedCount,
        flaky: run.flakyCount,
      },
    })),
    nextCursor,
  }
}

export const getRun = async (
  prisma: PrismaClient,
  projectId: string,
  runId: string,
): Promise<RunDetail | null> => {
  const run = await prisma.run.findFirst({
    where: { id: runId, projectId },
    select: {
      id: true,
      branch: true,
      commitSha: true,
      prNumber: true,
      ciProvider: true,
      status: true,
      trigger: true,
      startedAt: true,
      finishedAt: true,
      durationMs: true,
    },
  })
  if (!run) return null

  const executions = await prisma.testExecution.findMany({
    where: { runId, projectId },
    orderBy: [{ startedAt: 'asc' }, { attempt: 'asc' }],
    select: {
      id: true,
      testIdentityId: true,
      status: true,
      attempt: true,
      durationMs: true,
      errorMessage: true,
      artifactsRef: true,
      identity: { select: { filePath: true, suite: true, title: true } },
      rcaReport: { select: { id: true } },
    },
  })

  const counts = emptyCounts()
  for (const execution of executions) applyStatus(counts, execution.status, 1)

  return {
    id: run.id,
    branch: run.branch,
    commitSha: run.commitSha,
    prNumber: run.prNumber,
    ciProvider: run.ciProvider,
    status: run.status,
    trigger: run.trigger,
    startedAt: run.startedAt,
    finishedAt: run.finishedAt,
    durationMs: run.durationMs,
    counts,
    executions: executions.map((execution) => ({
      id: execution.id,
      testIdentityId: execution.testIdentityId,
      filePath: execution.identity.filePath,
      suite: execution.identity.suite,
      title: execution.identity.title,
      status: execution.status,
      attempt: execution.attempt,
      durationMs: execution.durationMs,
      errorMessage: execution.errorMessage,
      hasRca: execution.rcaReport !== null,
      artifacts: (execution.artifactsRef ?? []) as ArtifactRef[],
    })),
  }
}
