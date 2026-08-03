import type { HealthEventKind, TestHealthResult } from '@flakemetry/contracts'
import { matchCodeowners, parseCodeowners } from '@flakemetry/core'
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
  openCount: number,
): TestHealthResult['mttr'] => {
  const durations = paired.resolutions
    .filter((pair) => pair.resolvedAt >= windowStart)
    .map((pair) => pair.resolvedAt.getTime() - pair.flakedAt.getTime())
  return {
    resolvedCount: durations.length,
    openCount,
    meanMs: mean(durations),
    medianMs: median(durations),
  }
}

export const quarantineTrendFromEvents = (
  events: readonly HealthEventPoint[],
  windowStart: Date,
): TestHealthResult['quarantine']['trend'] => {
  const byTest = new Map<string, boolean>()
  const byDay = new Map<number, number>()

  for (const event of [...events].sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())) {
    if (event.kind === 'quarantined') byTest.set(event.testIdentityId, true)
    else if (event.kind === 'unquarantined') byTest.set(event.testIdentityId, false)
    else continue
    if (event.createdAt < windowStart) continue
    let held = 0
    for (const quarantined of byTest.values()) if (quarantined) held += 1
    byDay.set(dayStartUtc(event.createdAt).getTime(), held)
  }

  return [...byDay.entries()]
    .sort(([a], [b]) => a - b)
    .map(([day, count]) => ({ day: new Date(day), count }))
}

const ownedIdentityIds = async (
  prisma: PrismaClient,
  projectId: string,
  owner: string,
): Promise<string[]> => {
  const project = await prisma.project.findUnique({
    where: { id: projectId },
    select: { codeowners: true },
  })
  const rules = project?.codeowners ? parseCodeowners(project.codeowners) : []
  if (rules.length === 0) return []

  const identities = await prisma.testIdentity.findMany({
    where: { projectId },
    select: { id: true, filePath: true },
  })
  return identities
    .filter((identity) => matchCodeowners(rules, identity.filePath).includes(owner))
    .map((identity) => identity.id)
}

export const getTestHealthMetrics = async (
  prisma: PrismaClient,
  projectId: string,
  days = 90,
  owner?: string | null,
): Promise<TestHealthResult> => {
  const windowStart = since(days)
  const now = new Date()

  const scoped = owner ? await ownedIdentityIds(prisma, projectId, owner) : null
  if (scoped && scoped.length === 0)
    return {
      rangeDays: days,
      mttr: { resolvedCount: 0, openCount: 0, meanMs: null, medianMs: null },
      weekly: bucketWeekly([], windowStart, now),
      quarantine: { currentBacklog: 0, trend: [] },
      reliabilityTrend: [],
    }
  const identityFilter = scoped ? { in: scoped } : undefined

  const [rawEvents, currentlyFlaky, currentBacklog, quarantineDaily, reliabilityDaily] =
    await Promise.all([
      prisma.testHealthEvent.findMany({
        where: {
          projectId,
          createdAt: { gte: windowStart },
          ...(identityFilter ? { testIdentityId: identityFilter } : {}),
        },
        select: { testIdentityId: true, kind: true, createdAt: true },
        orderBy: { createdAt: 'asc' },
      }),
      prisma.flakyScore.count({
        where: {
          projectId,
          quarantineCandidate: true,
          ...(identityFilter ? { testIdentityId: identityFilter } : {}),
        },
      }),
      prisma.testIdentity.count({
        where: { projectId, quarantined: true, ...(identityFilter ? { id: identityFilter } : {}) },
      }),
      scoped
        ? []
        : prisma.flakyTrends.findMany({
            where: { projectId, day: { gte: windowStart } },
            select: { day: true, quarantinedCount: true },
            orderBy: { day: 'asc' },
          }),
      scoped
        ? prisma.dailyTestStats.groupBy({
            by: ['day'],
            where: { projectId, day: { gte: windowStart }, testIdentityId: identityFilter },
            _sum: { total: true, passed: true },
            orderBy: { day: 'asc' },
          })
        : prisma.suiteDaily.groupBy({
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

  // A flake resolved inside the window may have started long before it, so pairing
  // needs those tests' full history — but only theirs, rather than the whole log.
  const resolvedInWindow = [
    ...new Set(
      events.filter((event) => event.kind === 'stabilized').map((event) => event.testIdentityId),
    ),
  ]
  const pairingEvents: HealthEventPoint[] =
    resolvedInWindow.length === 0
      ? events
      : (
          await prisma.testHealthEvent.findMany({
            where: { projectId, testIdentityId: { in: resolvedInWindow } },
            select: { testIdentityId: true, kind: true, createdAt: true },
            orderBy: { createdAt: 'asc' },
          })
        ).map((event) => ({
          testIdentityId: event.testIdentityId,
          kind: event.kind as HealthEventKind,
          createdAt: event.createdAt,
        }))

  const paired = pairFlakeResolutions(pairingEvents)

  // The quarantine line has to know who was already held when the window opened,
  // so it reads the transitions themselves — far rarer than flake events — rather
  // than being rebuilt from the windowed slice, which would restart the count at zero.
  const quarantineEvents: HealthEventPoint[] = scoped
    ? (
        await prisma.testHealthEvent.findMany({
          where: {
            projectId,
            kind: { in: ['quarantined', 'unquarantined'] },
            ...(identityFilter ? { testIdentityId: identityFilter } : {}),
          },
          select: { testIdentityId: true, kind: true, createdAt: true },
          orderBy: { createdAt: 'asc' },
        })
      ).map((event) => ({
        testIdentityId: event.testIdentityId,
        kind: event.kind as HealthEventKind,
        createdAt: event.createdAt,
      }))
    : []

  const reliabilityTrend = reliabilityDaily.map((row) => {
    const total = row._sum.total ?? 0
    const passed = row._sum.passed ?? 0
    return { day: row.day, passRate: total > 0 ? passed / total : 1, total }
  })

  return {
    rangeDays: days,
    mttr: summarizeMttr(paired, windowStart, currentlyFlaky),
    weekly: bucketWeekly(events, windowStart, now),
    quarantine: {
      currentBacklog,
      trend: scoped
        ? quarantineTrendFromEvents(quarantineEvents, windowStart)
        : quarantineDaily.map((row) => ({ day: row.day, count: row.quarantinedCount })),
    },
    reliabilityTrend,
  }
}

export interface TeamHealthRow {
  owner: string
  currentlyFlaky: number
  quarantined: number
  introduced: number
  resolved: number
  net: number
}

export const getTeamHealthLeaderboard = async (
  prisma: PrismaClient,
  projectId: string,
  days = 90,
): Promise<TeamHealthRow[]> => {
  const windowStart = since(days)

  const project = await prisma.project.findUnique({
    where: { id: projectId },
    select: { codeowners: true },
  })
  const rules = project?.codeowners ? parseCodeowners(project.codeowners) : []
  if (rules.length === 0) return []

  const [identities, flakyScores, events] = await Promise.all([
    prisma.testIdentity.findMany({
      where: { projectId },
      select: { id: true, filePath: true, quarantined: true },
    }),
    prisma.flakyScore.findMany({
      where: { projectId, quarantineCandidate: true },
      select: { testIdentityId: true },
    }),
    prisma.testHealthEvent.findMany({
      where: { projectId, createdAt: { gte: windowStart } },
      select: { testIdentityId: true, kind: true },
    }),
  ])

  const flaggedFlaky = new Set(flakyScores.map((score) => score.testIdentityId))
  const ownersByIdentity = new Map(
    identities.map((identity) => [identity.id, matchCodeowners(rules, identity.filePath)]),
  )

  const rows = new Map<string, TeamHealthRow>()
  const rowFor = (owner: string): TeamHealthRow => {
    const existing = rows.get(owner)
    if (existing) return existing
    const created: TeamHealthRow = {
      owner,
      currentlyFlaky: 0,
      quarantined: 0,
      introduced: 0,
      resolved: 0,
      net: 0,
    }
    rows.set(owner, created)
    return created
  }

  for (const identity of identities) {
    for (const owner of ownersByIdentity.get(identity.id) ?? []) {
      const row = rowFor(owner)
      if (flaggedFlaky.has(identity.id)) row.currentlyFlaky += 1
      if (identity.quarantined) row.quarantined += 1
    }
  }

  for (const event of events) {
    if (event.kind !== 'flaked' && event.kind !== 'stabilized') continue
    for (const owner of ownersByIdentity.get(event.testIdentityId) ?? []) {
      const row = rowFor(owner)
      if (event.kind === 'flaked') row.introduced += 1
      else row.resolved += 1
    }
  }

  for (const row of rows.values()) row.net = row.introduced - row.resolved

  return [...rows.values()].sort(
    (a, b) =>
      b.net - a.net || b.currentlyFlaky - a.currentlyFlaky || a.owner.localeCompare(b.owner),
  )
}
