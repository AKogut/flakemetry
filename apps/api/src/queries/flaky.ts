import type { FlakyBoardInput, FlakyBoardResult, FlakyTrend } from '@flakemetry/contracts'
import type { PrismaClient, TestStatus } from '@flakemetry/db'

const TREND_WINDOW = 20
const TREND_EPSILON = 0.15

const isBad = (status: TestStatus): boolean => status === 'fail' || status === 'flaky'

const badnessRatio = (statuses: TestStatus[]): number =>
  statuses.length === 0 ? 0 : statuses.filter(isBad).length / statuses.length

const computeTrend = (ordered: TestStatus[]): FlakyTrend => {
  if (ordered.length < 4) return 'stable'
  const mid = Math.floor(ordered.length / 2)
  const older = badnessRatio(ordered.slice(0, mid))
  const recent = badnessRatio(ordered.slice(mid))
  if (recent - older > TREND_EPSILON) return 'rising'
  if (older - recent > TREND_EPSILON) return 'falling'
  return 'stable'
}

const trendByIdentity = async (
  prisma: PrismaClient,
  projectId: string,
  identityIds: string[],
): Promise<Map<string, FlakyTrend>> => {
  const result = new Map<string, FlakyTrend>()
  if (identityIds.length === 0) return result

  const executions = await prisma.testExecution.findMany({
    where: { projectId, testIdentityId: { in: identityIds } },
    orderBy: { startedAt: 'desc' },
    take: identityIds.length * TREND_WINDOW,
    select: { testIdentityId: true, status: true },
  })

  const grouped = new Map<string, TestStatus[]>()
  for (const execution of executions) {
    const list = grouped.get(execution.testIdentityId) ?? []
    if (list.length < TREND_WINDOW) list.push(execution.status)
    grouped.set(execution.testIdentityId, list)
  }

  for (const id of identityIds) {
    const statuses = (grouped.get(id) ?? []).reverse()
    result.set(id, computeTrend(statuses))
  }
  return result
}

export const flakyBoard = async (
  prisma: PrismaClient,
  projectId: string,
  input: FlakyBoardInput,
): Promise<FlakyBoardResult> => {
  const scores = await prisma.flakyScore.findMany({
    where: {
      projectId,
      score: { gte: input.minScore },
      ...(input.includeQuarantined ? {} : { identity: { quarantined: false } }),
    },
    orderBy: { score: 'desc' },
    take: input.limit,
    select: {
      testIdentityId: true,
      score: true,
      flipRate: true,
      passOnRerunRate: true,
      quarantineCandidate: true,
      lastFlakedAt: true,
      identity: {
        select: { filePath: true, suite: true, title: true, quarantined: true },
      },
    },
  })

  const trends = await trendByIdentity(
    prisma,
    projectId,
    scores.map((score) => score.testIdentityId),
  )

  return {
    items: scores.map((score) => ({
      testIdentityId: score.testIdentityId,
      filePath: score.identity.filePath,
      suite: score.identity.suite,
      title: score.identity.title,
      score: score.score,
      flipRate: score.flipRate,
      passOnRerunRate: score.passOnRerunRate,
      trend: trends.get(score.testIdentityId) ?? 'stable',
      lastFlakedAt: score.lastFlakedAt,
      quarantineCandidate: score.quarantineCandidate,
      quarantined: score.identity.quarantined,
    })),
  }
}
