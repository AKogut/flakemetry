import type { JsonRecord } from '@flakemetry/contracts'
import type { PrismaClient } from '@flakemetry/db'

export interface ParamBucket {
  id: string
  paramsHash: string
  params: JsonRecord | null
  label: string
  score: number | null
  quarantined: boolean
  total: number
  failed: number
  flaky: number
  lastSeenAt: Date
}

export interface ParamBucketGroup {
  suite: string
  title: string
  filePath: string
  buckets: ParamBucket[]
  totals: { total: number; failed: number; flaky: number; passRate: number }
}

export const describeParams = (params: JsonRecord | null, paramsHash: string): string => {
  if (!params) return paramsHash.slice(0, 8)
  const entries = Object.entries(params)
  if (entries.length === 0) return paramsHash.slice(0, 8)
  return entries.map(([key, value]) => `${key}=${JSON.stringify(value)}`).join(', ')
}

export const getParamBuckets = async (
  prisma: PrismaClient,
  projectId: string,
  testIdentityId: string,
): Promise<ParamBucketGroup | null> => {
  const identity = await prisma.testIdentity.findFirst({
    where: { id: testIdentityId, projectId },
    select: { suite: true, title: true, filePath: true, paramsHash: true },
  })
  if (!identity?.paramsHash) return null

  const variants = await prisma.testIdentity.findMany({
    where: {
      projectId,
      suite: identity.suite,
      title: identity.title,
      paramsHash: { not: null },
    },
    select: {
      id: true,
      filePath: true,
      paramsHash: true,
      params: true,
      quarantined: true,
      lastSeenAt: true,
      flakyScore: { select: { score: true } },
    },
  })
  if (variants.length < 2) return null

  const stats = await prisma.dailyTestStats.groupBy({
    by: ['testIdentityId'],
    where: { projectId, testIdentityId: { in: variants.map((variant) => variant.id) } },
    _sum: { total: true, failed: true, flaky: true },
  })
  const byIdentity = new Map(stats.map((row) => [row.testIdentityId, row._sum]))

  const buckets: ParamBucket[] = variants
    .map((variant) => {
      const sums = byIdentity.get(variant.id)
      const params = (variant.params ?? null) as JsonRecord | null
      const paramsHash = variant.paramsHash ?? ''
      return {
        id: variant.id,
        paramsHash,
        params,
        label: describeParams(params, paramsHash),
        score: variant.flakyScore?.score ?? null,
        quarantined: variant.quarantined,
        total: sums?.total ?? 0,
        failed: sums?.failed ?? 0,
        flaky: sums?.flaky ?? 0,
        lastSeenAt: variant.lastSeenAt,
      }
    })
    .sort((a, b) => (b.score ?? -1) - (a.score ?? -1) || a.label.localeCompare(b.label))

  const total = buckets.reduce((sum, bucket) => sum + bucket.total, 0)
  const failed = buckets.reduce((sum, bucket) => sum + bucket.failed, 0)
  const flaky = buckets.reduce((sum, bucket) => sum + bucket.flaky, 0)

  return {
    suite: identity.suite,
    title: identity.title,
    filePath: identity.filePath,
    buckets,
    totals: {
      total,
      failed,
      flaky,
      passRate: total > 0 ? (total - failed - flaky) / total : 1,
    },
  }
}
