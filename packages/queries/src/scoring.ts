import { computeFlakyScore, type ExecutionPoint, type FlakyScoreResult } from '@flakemetry/core'
import type { Prisma, PrismaClient } from '@flakemetry/db'

export const SCORING_WINDOW = 500

export interface ScoringOptions {
  now: Date
  threshold?: number
  minSamples?: number
}

export interface ScoredExecution {
  status: ExecutionPoint['status']
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
  identity: {
    title: string
    suite: string
    filePath: string
    quarantined: boolean
    quarantineOverride: string | null
  } | null
  previousQuarantineCandidate: boolean
}

interface ExecutionRow {
  test_identity_id: string
  status: ExecutionPoint['status']
  attempt: number
  started_at: Date
  run_id: string
  commit_sha: string
  ci_run_id: string | null
}

/**
 * One query for every identity's window instead of one per identity. `ROW_NUMBER` does the
 * per-identity `take` that Prisma can only express by asking again for each id, which is
 * what made scoring a run cost a round trip per test.
 */
const loadWindows = async (
  prisma: PrismaClient,
  projectId: string,
  identityIds: readonly string[],
): Promise<Map<string, ScoredExecution[]>> => {
  const rows = await prisma.$queryRaw<ExecutionRow[]>`
    SELECT test_identity_id, status, attempt, started_at, run_id, commit_sha, ci_run_id
    FROM (
      SELECT e.test_identity_id, e.status::text AS status, e.attempt, e.started_at, e.run_id,
             r.commit_sha, r.ci_run_id,
             ROW_NUMBER() OVER (
               PARTITION BY e.test_identity_id ORDER BY e.started_at DESC
             ) AS rn
      FROM test_execution e
      JOIN run r ON r.id = e.run_id
      WHERE e.project_id = ${projectId}::uuid
        AND e.test_identity_id = ANY(${identityIds as string[]}::uuid[])
    ) windowed
    WHERE rn <= ${SCORING_WINDOW}
    ORDER BY test_identity_id, started_at ASC
  `

  const byIdentity = new Map<string, ScoredExecution[]>()
  for (const row of rows) {
    const list = byIdentity.get(row.test_identity_id) ?? []
    list.push({
      status: row.status,
      attempt: Number(row.attempt),
      startedAt: row.started_at,
      runId: row.run_id,
      run: { commitSha: row.commit_sha, ciRunId: row.ci_run_id },
    })
    byIdentity.set(row.test_identity_id, list)
  }
  return byIdentity
}

/**
 * Scores every identity a run touched from a fixed number of queries rather than a fixed
 * number per test. `computeIdentityScore` below is this function with one id — deliberately,
 * so there is one scoring implementation and not a fast one that drifts from a correct one.
 */
export const computeIdentityScores = async (
  prisma: PrismaClient,
  orgId: string,
  projectId: string,
  identityIds: readonly string[],
  options: ScoringOptions,
): Promise<Map<string, ScoredIdentity>> => {
  const scored = new Map<string, ScoredIdentity>()
  if (identityIds.length === 0) return scored

  const [windows, identities, previousScores] = await Promise.all([
    loadWindows(prisma, projectId, identityIds),
    prisma.testIdentity.findMany({
      where: { id: { in: identityIds as string[] } },
      select: {
        id: true,
        title: true,
        suite: true,
        filePath: true,
        quarantined: true,
        quarantineOverride: true,
      },
    }),
    prisma.flakyScore.findMany({
      where: { testIdentityId: { in: identityIds as string[] } },
      select: { testIdentityId: true, quarantineCandidate: true },
    }),
  ])

  const identityById = new Map(identities.map(({ id, ...rest }) => [id, rest]))
  const previousById = new Map(
    previousScores.map((row) => [row.testIdentityId, row.quarantineCandidate]),
  )

  // The run lookups are shared: every identity in a run references largely the same runs, so
  // asking once for the union replaces N nearly identical queries with one.
  const allExecutions = [...windows.values()].flat()
  const runIds = [...new Set(allExecutions.map((execution) => execution.runId))]
  const ciRunIds = [
    ...new Set(
      allExecutions
        .map((execution) => execution.run.ciRunId)
        .filter((ciRunId): ciRunId is string => Boolean(ciRunId)),
    ),
  ]

  const groupRuns =
    runIds.length === 0
      ? []
      : await prisma.run.findMany({
          where: {
            projectId,
            OR: [
              { id: { in: runIds } },
              ...(ciRunIds.length > 0 ? [{ ciRunId: { in: ciRunIds } }] : []),
            ],
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

  for (const identityId of identityIds) {
    const executions = windows.get(identityId) ?? []

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

    scored.set(identityId, {
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
      identity: identityById.get(identityId) ?? null,
      previousQuarantineCandidate: previousById.get(identityId) ?? false,
    })
  }

  return scored
}

export const computeIdentityScore = async (
  prisma: PrismaClient,
  orgId: string,
  projectId: string,
  identityId: string,
  options: ScoringOptions,
): Promise<ScoredIdentity> => {
  const scored = await computeIdentityScores(prisma, orgId, projectId, [identityId], options)
  const one = scored.get(identityId)
  if (one) return one

  throw new Error(`scoring produced no result for identity ${identityId}`)
}
