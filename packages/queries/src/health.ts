import type { HealthEventKind, TestHealthResult } from '@flakemetry/contracts'
import type { PrismaClient } from '@flakemetry/db'

const DAY_MS = 24 * 60 * 60 * 1000
const WEEK_MS = 7 * DAY_MS

const since = (days: number): Date => {
  const date = new Date(Date.now() - days * DAY_MS)
  date.setUTCHours(0, 0, 0, 0)
  return date
}

export const dayStartUtc = (date: Date): Date => {
  const start = new Date(date)
  start.setUTCHours(0, 0, 0, 0)
  return start
}

export const weekStartUtc = (date: Date): Date => {
  const start = dayStartUtc(date)
  const isoDay = (start.getUTCDay() + 6) % 7
  return new Date(start.getTime() - isoDay * DAY_MS)
}

export const mean = (values: readonly number[]): number | null =>
  values.length === 0 ? null : values.reduce((sum, value) => sum + value, 0) / values.length

export const median = (values: readonly number[]): number | null => {
  if (values.length === 0) return null
  const sorted = [...values].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 0 ? (sorted[mid - 1]! + sorted[mid]!) / 2 : sorted[mid]!
}

export interface HealthEventPoint {
  testIdentityId: string
  kind: HealthEventKind
  createdAt: Date
}

export interface ResolutionPair {
  flakedAt: Date
  resolvedAt: Date
}

export interface PairedHealth {
  resolutions: ResolutionPair[]
  openCount: number
}

export const pairFlakeResolutions = (events: readonly HealthEventPoint[]): PairedHealth => {
  const byTest = new Map<string, HealthEventPoint[]>()
  for (const event of events) {
    const list = byTest.get(event.testIdentityId) ?? []
    list.push(event)
    byTest.set(event.testIdentityId, list)
  }

  const resolutions: ResolutionPair[] = []
  let openCount = 0

  for (const list of byTest.values()) {
    const ordered = [...list].sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())
    let openAt: Date | null = null
    for (const event of ordered) {
      if (event.kind === 'flaked') {
        if (openAt === null) openAt = event.createdAt
      } else if (event.kind === 'stabilized') {
        if (openAt !== null) {
          resolutions.push({ flakedAt: openAt, resolvedAt: event.createdAt })
          openAt = null
        }
      }
    }
    if (openAt !== null) openCount += 1
  }

  return { resolutions, openCount }
}

export const bucketWeekly = (
  events: readonly HealthEventPoint[],
  windowStart: Date,
  now: Date,
): TestHealthResult['weekly'] => {
  const firstWeek = weekStartUtc(windowStart)
  const weeks: { weekStart: Date; introduced: number; resolved: number }[] = []
  const index = new Map<number, number>()
  for (let start = firstWeek.getTime(); start <= now.getTime(); start += WEEK_MS) {
    index.set(start, weeks.length)
    weeks.push({ weekStart: new Date(start), introduced: 0, resolved: 0 })
  }

  for (const event of events) {
    if (event.createdAt < windowStart) continue
    const bucket = weeks[index.get(weekStartUtc(event.createdAt).getTime()) ?? -1]
    if (!bucket) continue
    if (event.kind === 'flaked') bucket.introduced += 1
    else if (event.kind === 'stabilized') bucket.resolved += 1
  }

  return weeks
}

export const summarizeMttr = (
  paired: PairedHealth,
  windowStart: Date,
): TestHealthResult['mttr'] => {
  const durations = paired.resolutions
    .filter((pair) => pair.resolvedAt >= windowStart)
    .map((pair) => pair.resolvedAt.getTime() - pair.flakedAt.getTime())
  return {
    resolvedCount: durations.length,
    openCount: paired.openCount,
    meanMs: mean(durations),
    medianMs: median(durations),
  }
}

export const getTestHealthMetrics = async (
  prisma: PrismaClient,
  projectId: string,
  days = 90,
): Promise<TestHealthResult> => {
  const windowStart = since(days)
  const now = new Date()

  const [rawEvents, currentBacklog, quarantineDaily, reliabilityDaily] = await Promise.all([
    prisma.testHealthEvent.findMany({
      where: { projectId },
      select: { testIdentityId: true, kind: true, createdAt: true },
      orderBy: { createdAt: 'asc' },
    }),
    prisma.testIdentity.count({ where: { projectId, quarantined: true } }),
    prisma.flakyTrends.findMany({
      where: { projectId, day: { gte: windowStart } },
      select: { day: true, quarantinedCount: true },
      orderBy: { day: 'asc' },
    }),
    prisma.suiteDaily.groupBy({
      by: ['day'],
      where: { projectId, day: { gte: windowStart } },
      _sum: { total: true, passed: true },
      orderBy: { day: 'asc' },
    }),
  ])

  const events: HealthEventPoint[] = rawEvents.map((event) => ({
    testIdentityId: event.testIdentityId,
    kind: event.kind as HealthEventKind,
    createdAt: event.createdAt,
  }))

  const paired = pairFlakeResolutions(events)

  const reliabilityTrend = reliabilityDaily.map((row) => {
    const total = row._sum.total ?? 0
    const passed = row._sum.passed ?? 0
    return { day: row.day, passRate: total > 0 ? passed / total : 1, total }
  })

  return {
    rangeDays: days,
    mttr: summarizeMttr(paired, windowStart),
    weekly: bucketWeekly(events, windowStart, now),
    quarantine: {
      currentBacklog,
      trend: quarantineDaily.map((row) => ({ day: row.day, count: row.quarantinedCount })),
    },
    reliabilityTrend,
  }
}
