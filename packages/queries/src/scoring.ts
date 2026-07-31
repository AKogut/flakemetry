import { computeFlakyScore, type ExecutionPoint, type FlakyScoreResult } from '@flakemetry/core'
import type { Prisma, PrismaClient } from '@flakemetry/db'

export const SCORING_WINDOW = 500

export interface ScoringOptions {
  now: Date
  threshold?: number
  minSamples?: number
}

export interface ScoredExecution {
  status: string
  attempt: number
  startedAt: Date
  runId: string
  run: { commitSha: string; ciRunId: string | null }
}

export interface ScoredIdentity {
  result: FlakyScoreResult
  data: {
    orgId: string
    projectId: string
    score: number
    flipRate: number
    passOnRerunRate: number
    sameShaVariance: number
    entropy: number
    failIsolation: number
    reasonCodes: Prisma.InputJsonValue
    quarantineCandidate: boolean
    lastFlakedAt: Date | null
    modelVersion: string
  }
  executions: ScoredExecution[]
  identity: { title: string; suite: string; filePath: string; quarantined: boolean } | null
  previousQuarantineCandidate: boolean
}

export const computeIdentityScore = async (
  prisma: PrismaClient,
  orgId: string,
  projectId: string,
  identityId: string,
  options: ScoringOptions,
): Promise<ScoredIdentity> => {
  const recent = await prisma.testExecution.findMany({
    where: { projectId, testIdentityId: identityId },
    select: {
      status: true,
      attempt: true,
      startedAt: true,
      runId: true,
      run: { select: { commitSha: true, ciRunId: true } },
    },
    orderBy: { startedAt: 'desc' },
    take: SCORING_WINDOW,
  })
  const executions = recent.reverse()

  const [identity, previousScore] = await Promise.all([
    prisma.testIdentity.findUnique({
      where: { id: identityId },
      select: { title: true, suite: true, filePath: true, quarantined: true },
    }),
    prisma.flakyScore.findUnique({
      where: { testIdentityId: identityId },
      select: { quarantineCandidate: true },
    }),
  ])

  const runIds = [...new Set(executions.map((execution) => execution.runId))]
  const ciRunIds = [
    ...new Set(
      executions
        .map((execution) => execution.run.ciRunId)
        .filter((ciRunId): ciRunId is string => Boolean(ciRunId)),
    ),
  ]

  const groupRuns = await prisma.run.findMany({
    where: {
      projectId,
      OR: [{ id: { in: runIds } }, ...(ciRunIds.length > 0 ? [{ ciRunId: { in: ciRunIds } }] : [])],
    },
    select: { id: true, ciRunId: true },
  })
  const keyByRunId = new Map(groupRuns.map((run) => [run.id, run.ciRunId ?? run.id]))

  const failingTestsByKey = new Map<string, Set<string>>()
  if (groupRuns.length > 0) {
    const grouped = await prisma.testExecution.groupBy({
      by: ['runId', 'testIdentityId'],
      where: {
        projectId,
        runId: { in: groupRuns.map((run) => run.id) },
        status: 'fail',
      },
      _count: { _all: true },
    })
    for (const row of grouped) {
      const key = keyByRunId.get(row.runId) ?? row.runId
      const set = failingTestsByKey.get(key) ?? new Set<string>()
      set.add(row.testIdentityId)
      failingTestsByKey.set(key, set)
    }
  }

  const history: ExecutionPoint[] = executions.map((execution) => ({
    status: execution.status,
    attempt: execution.attempt,
    startedAt: execution.startedAt,
    commitSha: execution.run.commitSha,
    runFailureCount:
      failingTestsByKey.get(keyByRunId.get(execution.runId) ?? execution.runId)?.size ?? 0,
  }))

  const result = computeFlakyScore(history, {
    now: options.now,
    threshold: options.threshold,
    minSamples: options.minSamples,
    windowSize: SCORING_WINDOW,
  })

  const lastFlakedAt = executions
    .filter((execution) => execution.status === 'fail' || execution.status === 'flaky')
    .map((execution) => execution.startedAt)
    .sort((a, b) => b.getTime() - a.getTime())[0]

  return {
    result,
    data: {
      orgId,
      projectId,
      score: result.score,
      flipRate: result.flipRate,
      passOnRerunRate: result.passOnRerunRate,
      sameShaVariance: result.sameShaVariance,
      entropy: result.entropy,
      failIsolation: result.failIsolation,
      reasonCodes: result.reasonCodes as unknown as Prisma.InputJsonValue,
      quarantineCandidate: result.quarantineCandidate,
      lastFlakedAt: lastFlakedAt ?? null,
      modelVersion: result.modelVersion,
    },
    executions,
    identity,
    previousQuarantineCandidate: previousScore?.quarantineCandidate ?? false,
  }
}
