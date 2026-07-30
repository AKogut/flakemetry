import type { FlakyBoardInput, FlakyBoardResult, FlakyTrend } from '@flakemetry/contracts'
import { matchCodeowners, parseCodeowners } from '@flakemetry/core'
import type { PrismaClient } from '@flakemetry/db'

const TREND_EPSILON = 0.15

const mean = (values: number[]): number =>
  values.length === 0 ? 0 : values.reduce((sum, value) => sum + value, 0) / values.length

const computeTrend = (dailyBadness: number[]): FlakyTrend => {
  if (dailyBadness.length < 2) return 'stable'
  const mid = Math.floor(dailyBadness.length / 2)
  const older = mean(dailyBadness.slice(0, mid))
  const recent = mean(dailyBadness.slice(mid))
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

  const rows = await prisma.dailyTestStats.findMany({
    where: { projectId, testIdentityId: { in: identityIds } },
    orderBy: { day: 'asc' },
    select: { testIdentityId: true, total: true, failed: true, flaky: true },
  })

  const grouped = new Map<string, number[]>()
  for (const row of rows) {
    const badness = row.total > 0 ? (row.failed + row.flaky) / row.total : 0
    const list = grouped.get(row.testIdentityId) ?? []
    list.push(badness)
    grouped.set(row.testIdentityId, list)
  }

  for (const id of identityIds) {
    result.set(id, computeTrend(grouped.get(id) ?? []))
  }
  return result
}

export const flakyBoard = async (
  prisma: PrismaClient,
  projectId: string,
  input: FlakyBoardInput,
): Promise<FlakyBoardResult> => {
  const project = await prisma.project.findUnique({
    where: { id: projectId },
    select: { codeowners: true },
  })
  const rules = project?.codeowners ? parseCodeowners(project.codeowners) : []
  const fetchLimit = input.owner ? Math.max(input.limit, 500) : input.limit

  const scores = await prisma.flakyScore.findMany({
    where: {
      projectId,
      score: { gte: input.minScore },
      ...(input.includeQuarantined ? {} : { identity: { quarantined: false } }),
    },
    orderBy: { score: 'desc' },
    take: fetchLimit,
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

  const resolved = scores.map((score) => ({
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
    owners: matchCodeowners(rules, score.identity.filePath),
  }))

  const filtered = input.owner
    ? resolved.filter((item) => item.owners.includes(input.owner!))
    : resolved

  return { items: filtered.slice(0, input.limit) }
}
