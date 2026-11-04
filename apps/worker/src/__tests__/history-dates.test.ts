import type { IngestRunBatch } from '@flakemetry/contracts'
import { createPrismaClient } from '@flakemetry/db'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'

import { processJob } from '../processor'

const hasDb = Boolean(process.env.DATABASE_URL)
const prisma = createPrismaClient()

const DAY_MS = 24 * 60 * 60 * 1000
const FIRST_RUN = new Date('2026-05-04T10:00:00Z')
const REBUILT_AT = new Date('2026-11-04T12:00:00Z')

const onDay = (dayNumber: number, offsetMs = 0): Date =>
  new Date(FIRST_RUN.getTime() + dayNumber * DAY_MS + offsetMs)

const seedProject = async () => {
  const org = await prisma.org.create({
    data: { name: 'Acme', slug: `acme-${Date.now()}-${Math.random()}` },
  })
  const project = await prisma.project.create({ data: { orgId: org.id, name: 'Web', slug: 'web' } })
  return { orgId: org.id, projectId: project.id }
}

const execution = (status: 'pass' | 'fail' | 'flaky', attempt: number, startedAt: Date) => ({
  filePath: 'e2e/login.spec.ts',
  suite: 'auth',
  title: 'logs in',
  status,
  attempt,
  startedAt,
  durationMs: 100,
})

const flakedRun = (dayNumber: number): IngestRunBatch => ({
  contractVersion: '0.1.0',
  idempotencyKey: `flaked-${dayNumber}`,
  resource: {
    ciProvider: 'github_actions',
    commitSha: `sha-${dayNumber}`,
    branch: 'main',
    trigger: 'schedule',
  },
  run: { status: 'passed', startedAt: onDay(dayNumber) },
  executions: [
    execution('fail', 1, onDay(dayNumber, 1_000)),
    execution('flaky', 2, onDay(dayNumber, 2_000)),
  ],
})

const greenRun = (dayNumber: number): IngestRunBatch => ({
  contractVersion: '0.1.0',
  idempotencyKey: `green-${dayNumber}`,
  resource: {
    ciProvider: 'github_actions',
    commitSha: `sha-${dayNumber}`,
    branch: 'main',
    trigger: 'schedule',
  },
  run: { status: 'passed', startedAt: onDay(dayNumber) },
  executions: [execution('pass', 1, onDay(dayNumber, 1_000))],
})

const history: IngestRunBatch[] = [
  flakedRun(0),
  flakedRun(1),
  ...Array.from({ length: 40 }, (_, index) => greenRun(index + 2)),
]

const scoringPolicy = { threshold: 0.7, minSamples: 1 }

const healthEvents = async (projectId: string) =>
  (
    await prisma.testHealthEvent.findMany({
      where: { projectId },
      orderBy: { createdAt: 'asc' },
      select: { kind: true, createdAt: true },
    })
  ).map((event) => `${event.kind} ${event.createdAt.toISOString()}`)

const trendDays = async (projectId: string) =>
  (
    await prisma.flakyTrends.findMany({
      where: { projectId },
      orderBy: { day: 'asc' },
      select: { day: true, flakyCount: true },
    })
  ).map((row) => `${row.day.toISOString().slice(0, 10)} ${row.flakyCount}`)

describe.skipIf(!hasDb)('dating health history from executions', () => {
  beforeEach(async () => {
    await prisma.testHealthEvent.deleteMany()
    await prisma.flakyTrends.deleteMany()
    await prisma.flakyScore.deleteMany()
    await prisma.testExecution.deleteMany()
    await prisma.testIdentity.deleteMany()
    await prisma.run.deleteMany()
    await prisma.project.deleteMany()
    await prisma.org.deleteMany()
  })

  afterAll(async () => {
    await prisma.$disconnect()
  })

  it('gives a replay months later the same history as processing each run when it happened', async () => {
    const live = await seedProject()
    for (const batch of history) {
      await processJob(prisma, batch, {
        ...live,
        ...scoringPolicy,
        now: new Date(batch.run.startedAt.getTime() + 60_000),
      })
    }

    const replayed = await seedProject()
    for (const batch of history) {
      await processJob(prisma, batch, { ...replayed, ...scoringPolicy, now: REBUILT_AT })
    }

    const replayedEvents = await healthEvents(replayed.projectId)
    expect(replayedEvents.map((event) => event.split(' ')[0])).toEqual(['flaked', 'stabilized'])
    expect(replayedEvents).toEqual(await healthEvents(live.projectId))

    const replayedDays = await trendDays(replayed.projectId)
    expect(replayedDays).toHaveLength(history.length)
    expect(replayedDays).toEqual(await trendDays(live.projectId))

    const score = (projectId: string) =>
      prisma.flakyScore.findFirstOrThrow({ where: { projectId } })
    expect((await score(replayed.projectId)).score).toBeCloseTo(
      (await score(live.projectId)).score,
      6,
    )
  }, 60_000)

  it('dates events and trend rows from the run rather than the time of processing', async () => {
    const ctx = await seedProject()
    for (const batch of [flakedRun(0), greenRun(1)]) {
      await processJob(prisma, batch, { ...ctx, ...scoringPolicy, now: REBUILT_AT })
    }

    expect(await healthEvents(ctx.projectId)).toEqual(
      expect.arrayContaining([`flaked ${onDay(0, 2_000).toISOString()}`]),
    )
    expect(await trendDays(ctx.projectId)).toEqual(['2026-05-04 1', '2026-05-05 1'])
  })

  it('adds nothing when the same run is delivered again', async () => {
    const ctx = await seedProject()
    await processJob(prisma, flakedRun(0), { ...ctx, ...scoringPolicy, now: onDay(0, 60_000) })
    const events = await healthEvents(ctx.projectId)
    const days = await trendDays(ctx.projectId)

    await processJob(prisma, flakedRun(0), { ...ctx, ...scoringPolicy, now: REBUILT_AT })

    expect(await healthEvents(ctx.projectId)).toEqual(events)
    expect(await trendDays(ctx.projectId)).toEqual(days)
  })

  it('keeps a late run from rewriting the past or reversing a transition', async () => {
    const ctx = await seedProject()
    const policy = { threshold: 0.88, minSamples: 1 }
    await processJob(prisma, flakedRun(10), { ...ctx, ...policy, now: onDay(10, 60_000) })
    expect(await trendDays(ctx.projectId)).toEqual(['2026-05-14 1'])

    await processJob(prisma, greenRun(3), { ...ctx, ...policy, now: onDay(11) })

    const events = await prisma.testHealthEvent.findMany({
      where: { projectId: ctx.projectId },
      orderBy: { createdAt: 'asc' },
      select: { kind: true, createdAt: true },
    })
    expect(events.map((event) => event.kind)).toEqual(['flaked', 'stabilized'])
    expect(events[0]?.createdAt.toISOString()).toBe(onDay(10, 2_000).toISOString())
    expect(events[1]!.createdAt.getTime()).toBeGreaterThan(events[0]!.createdAt.getTime())

    expect(await trendDays(ctx.projectId)).toEqual(['2026-05-14 0'])
  })

  it('never dates history after the moment it was processed', async () => {
    const ctx = await seedProject()
    const processedAt = onDay(0, 60_000)
    await processJob(prisma, flakedRun(5), { ...ctx, ...scoringPolicy, now: processedAt })

    const [event] = await prisma.testHealthEvent.findMany({ where: { projectId: ctx.projectId } })
    expect(event?.createdAt.toISOString()).toBe(processedAt.toISOString())
    expect(await trendDays(ctx.projectId)).toEqual(['2026-05-04 1'])
  })
})
