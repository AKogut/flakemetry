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

const SUSPECT_RUN_MS = 1000

interface DurationEvidenceRow {
  run_id: string
  starts: number
  total_ms: bigint
  longest_ms: bigint
  span_ms: bigint | null
}

export interface RunDurationEvidence {
  starts: number
  totalMs: number
  longestMs: number
  spanMs: number
}

const durationEvidence = async (
  prisma: PrismaClient,
  runIds: string[],
): Promise<Map<string, RunDurationEvidence>> => {
  if (runIds.length === 0) return new Map()
  const rows = await prisma.$queryRaw<DurationEvidenceRow[]>`
    SELECT run_id::text AS run_id,
           count(DISTINCT started_at)::int AS starts,
           coalesce(sum(duration_ms), 0)::bigint AS total_ms,
           coalesce(max(duration_ms), 0)::bigint AS longest_ms,
           (extract(epoch FROM max(started_at + duration_ms * interval '1 millisecond') - min(started_at)) * 1000)::bigint AS span_ms
    FROM test_execution
    WHERE run_id = ANY(${runIds}::uuid[]) AND status <> 'skip'
    GROUP BY run_id
  `
  return new Map(
    rows.map((row) => [
      row.run_id,
      {
        starts: row.starts,
        totalMs: Number(row.total_ms),
        longestMs: Number(row.longest_ms),
        spanMs: Number(row.span_ms ?? 0),
      },
    ]),
  )
}

const needsDurationEvidence = (stored: number | null): boolean =>
  stored === null || stored < SUSPECT_RUN_MS

export const resolveRunDuration = (
  stored: number | null,
  evidence: RunDurationEvidence | undefined,
): { durationMs: number | null; durationEstimated: boolean } => {
  if (stored !== null && (!evidence || stored >= evidence.longestMs)) {
    return { durationMs: stored, durationEstimated: false }
  }
  if (evidence && evidence.totalMs > 0) {
    return evidence.starts > 1
      ? { durationMs: evidence.spanMs, durationEstimated: false }
      : { durationMs: evidence.totalMs, durationEstimated: true }
  }
  return { durationMs: stored, durationEstimated: false }
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
      variant: true,
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
  const evidence = await durationEvidence(
    prisma,
    page.filter((run) => needsDurationEvidence(run.durationMs)).map((run) => run.id),
  )

  return {
    items: page.map((run) => ({
      id: run.id,
      branch: run.branch,
      commitSha: run.commitSha,
      prNumber: run.prNumber,
      ciProvider: run.ciProvider,
      status: run.status,
      variant: run.variant,
      startedAt: run.startedAt,
      ...resolveRunDuration(run.durationMs, evidence.get(run.id)),
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
      variant: true,
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
  const evidence = needsDurationEvidence(run.durationMs)
    ? await durationEvidence(prisma, [run.id])
    : new Map<string, RunDurationEvidence>()

  return {
    id: run.id,
    branch: run.branch,
    commitSha: run.commitSha,
    prNumber: run.prNumber,
    ciProvider: run.ciProvider,
    status: run.status,
    variant: run.variant,
    trigger: run.trigger,
    startedAt: run.startedAt,
    finishedAt: run.finishedAt,
    ...resolveRunDuration(run.durationMs, evidence.get(run.id)),
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
