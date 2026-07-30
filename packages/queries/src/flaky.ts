import type { FlakyBoardInput, FlakyBoardResult, FlakyTrend } from '@flakemetry/contracts'
import { matchCodeowners, parseCodeowners } from '@flakemetry/core'
import { Prisma, type PrismaClient } from '@flakemetry/db'

const TREND_EPSILON = 0.15

const scoreSelect = Prisma.validator<Prisma.FlakyScoreSelect>()({
  testIdentityId: true,
  score: true,
  flipRate: true,
  passOnRerunRate: true,
  quarantineCandidate: true,
  lastFlakedAt: true,
  identity: {
    select: { filePath: true, suite: true, title: true, quarantined: true },
  },
})

type ScoreRow = Prisma.FlakyScoreGetPayload<{ select: typeof scoreSelect }>

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

  const where: Prisma.FlakyScoreWhereInput = {
    projectId,
    score: { gte: input.minScore },
    ...(input.includeQuarantined ? {} : { identity: { quarantined: false } }),
  }

  let scores: ScoreRow[]
  if (input.owner) {
    const owner = input.owner
    const collected: ScoreRow[] = []
    const PAGE = 200
    let cursor: string | undefined
    while (collected.length < input.limit) {
      const page = await prisma.flakyScore.findMany({
        where,
        orderBy: [{ score: 'desc' }, { testIdentityId: 'asc' }],
        take: PAGE,
        ...(cursor ? { skip: 1, cursor: { testIdentityId: cursor } } : {}),
        select: scoreSelect,
      })
      if (page.length === 0) break
      for (const row of page) {
        if (matchCodeowners(rules, row.identity.filePath).includes(owner)) {
          collected.push(row)
          if (collected.length >= input.limit) break
        }
      }
      cursor = page[page.length - 1]!.testIdentityId
      if (page.length < PAGE) break
    }
    scores = collected
  } else {
    scores = await prisma.flakyScore.findMany({
      where,
      orderBy: { score: 'desc' },
      take: input.limit,
      select: scoreSelect,
    })
  }

  const trends = await trendByIdentity(
    prisma,
    projectId,
    scores.map((score) => score.testIdentityId),
  )

  const items = scores.map((score) => ({
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

  return { items }
}
