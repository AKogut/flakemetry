import { randomUUID } from 'node:crypto'

import { PrismaClient } from '@flakemetry/db'
import type { TrackerProvider } from '@flakemetry/notify'
import { afterAll, describe, expect, it } from 'vitest'

import { syncProjectTracker } from '../tracker'

const hasDb = Boolean(process.env.DATABASE_URL)
const prisma = new PrismaClient()

const NOW = new Date('2026-08-05T12:00:00Z')
const daysAgo = (days: number): Date => new Date(NOW.getTime() - days * 24 * 60 * 60 * 1000)

const ENV = { FLAKEMETRY_TRACKER_TOKEN: 'test-token' }

interface Recorded {
  created: { title: string; body: string }[]
  closed: string[]
  reopened: string[]
  updated: string[]
}

const fakeProvider = (): { provider: TrackerProvider; log: Recorded } => {
  const log: Recorded = { created: [], closed: [], reopened: [], updated: [] }
  let next = 100
  return {
    log,
    provider: {
      name: 'github',
      create: async (input) => {
        log.created.push({ title: input.title, body: input.body })
        next += 1
        return { externalId: String(next), url: `https://example.test/issues/${next}` }
      },
      update: async (externalId) => {
        log.updated.push(externalId)
      },
      comment: async () => {},
      close: async (externalId) => {
        log.closed.push(externalId)
      },
      reopen: async (externalId) => {
        log.reopened.push(externalId)
      },
    },
  }
}

const seed = async (options: {
  flaky: boolean
  flakedDaysAgo?: number
  stableDaysAgo?: number
}) => {
  const slug = `tracker-${randomUUID().slice(0, 8)}`
  const org = await prisma.org.create({ data: { name: slug, slug } })
  const project = await prisma.project.create({
    data: { orgId: org.id, name: slug, slug, repository: 'acme/web' },
  })
  const tenant = { orgId: org.id, projectId: project.id }

  await prisma.projectPolicy.create({
    data: { ...tenant, trackerEnabled: true, trackerAfterDays: 3, trackerRecoveryDays: 7 },
  })

  const identity = await prisma.testIdentity.create({
    data: {
      ...tenant,
      fingerprint: randomUUID(),
      filePath: 'e2e/login.spec.ts',
      suite: 'auth',
      title: 'logs in',
    },
  })

  await prisma.flakyScore.create({
    data: {
      ...tenant,
      testIdentityId: identity.id,
      score: options.flaky ? 0.86 : 0.1,
      flipRate: 0.4,
      passOnRerunRate: 0.85,
      sameShaVariance: 0.6,
      entropy: 0.9,
      failIsolation: 0.8,
      reasonCodes: [{ code: 'PASS_ON_RERUN', message: 'passed on rerun' }],
      quarantineCandidate: options.flaky,
      modelVersion: '0.1.0',
    },
  })

  if (options.flakedDaysAgo !== undefined) {
    await prisma.testHealthEvent.create({
      data: {
        ...tenant,
        testIdentityId: identity.id,
        kind: 'flaked',
        createdAt: daysAgo(options.flakedDaysAgo),
      },
    })
  }
  if (options.stableDaysAgo !== undefined) {
    await prisma.testHealthEvent.create({
      data: {
        ...tenant,
        testIdentityId: identity.id,
        kind: 'stabilized',
        createdAt: daysAgo(options.stableDaysAgo),
      },
    })
  }

  return { ...tenant, identityId: identity.id }
}

describe.skipIf(!hasDb)('tracker sync', () => {
  afterAll(async () => {
    await prisma.$disconnect()
  })

  it('files one issue for a persistent flake and records it', async () => {
    const { projectId, identityId } = await seed({ flaky: true, flakedDaysAgo: 5 })
    const { provider, log } = fakeProvider()

    const result = await syncProjectTracker(prisma, projectId, { provider, env: ENV, now: NOW })

    expect(result.opened).toBe(1)
    expect(log.created).toHaveLength(1)
    expect(log.created[0]?.title).toContain('logs in')

    const stored = await prisma.trackerIssue.findUniqueOrThrow({
      where: { testIdentityId: identityId },
    })
    expect(stored.state).toBe('open')
  })

  it('is safe to run again — the second sweep files nothing', async () => {
    const { projectId } = await seed({ flaky: true, flakedDaysAgo: 5 })
    const { provider, log } = fakeProvider()

    await syncProjectTracker(prisma, projectId, { provider, env: ENV, now: NOW })
    const second = await syncProjectTracker(prisma, projectId, { provider, env: ENV, now: NOW })

    // The sweep runs hourly. If it were not idempotent it would file an issue every hour.
    expect(second.opened).toBe(0)
    expect(log.created).toHaveLength(1)
  })

  it('closes the issue when the test recovers, then reopens the same one', async () => {
    // Flaked three weeks ago so that a recovery eight days ago is still long enough to
    // clear the policy — the order of the events is what decides, not their count.
    const { projectId, identityId, orgId } = await seed({ flaky: true, flakedDaysAgo: 21 })
    const { provider, log } = fakeProvider()

    await syncProjectTracker(prisma, projectId, { provider, env: ENV, now: NOW })
    const opened = await prisma.trackerIssue.findUniqueOrThrow({
      where: { testIdentityId: identityId },
    })

    await prisma.flakyScore.update({
      where: { testIdentityId: identityId },
      data: { quarantineCandidate: false, score: 0.05 },
    })
    await prisma.testHealthEvent.create({
      data: {
        orgId,
        projectId,
        testIdentityId: identityId,
        kind: 'stabilized',
        createdAt: daysAgo(8),
      },
    })

    const closing = await syncProjectTracker(prisma, projectId, { provider, env: ENV, now: NOW })
    expect(closing.closed).toBe(1)
    expect(log.closed).toEqual([opened.externalId])

    await prisma.flakyScore.update({
      where: { testIdentityId: identityId },
      data: { quarantineCandidate: true, score: 0.9 },
    })
    await prisma.testHealthEvent.create({
      data: {
        orgId,
        projectId,
        testIdentityId: identityId,
        kind: 'flaked',
        createdAt: daysAgo(4),
      },
    })

    const reopening = await syncProjectTracker(prisma, projectId, { provider, env: ENV, now: NOW })
    expect(reopening.reopened).toBe(1)
    expect(log.reopened).toEqual([opened.externalId])
    // The same ticket, not a second one — history stays in one place.
    expect(log.created).toHaveLength(1)
  })

  it('does nothing when the policy is off', async () => {
    const { projectId } = await seed({ flaky: true, flakedDaysAgo: 5 })
    await prisma.projectPolicy.update({
      where: { projectId },
      data: { trackerEnabled: false },
    })
    const { provider, log } = fakeProvider()

    const result = await syncProjectTracker(prisma, projectId, { provider, env: ENV, now: NOW })

    expect(result.opened).toBe(0)
    expect(log.created).toEqual([])
  })

  it('files nothing without a token, even with the policy on', async () => {
    const { projectId } = await seed({ flaky: true, flakedDaysAgo: 5 })

    // No provider injected and no credentials: the feature has to stay inert rather than
    // half-file anything.
    const result = await syncProjectTracker(prisma, projectId, { env: {}, now: NOW })

    expect(result).toEqual({ opened: 0, reopened: 0, closed: 0, updated: 0, failed: 0 })
  })

  it('records nothing when the provider rejects the request', async () => {
    const { projectId, identityId } = await seed({ flaky: true, flakedDaysAgo: 5 })
    const { provider } = fakeProvider()
    const failing: TrackerProvider = {
      ...provider,
      create: async () => {
        throw new Error('403 from the tracker')
      },
    }

    const result = await syncProjectTracker(prisma, projectId, {
      provider: failing,
      env: ENV,
      now: NOW,
    })

    expect(result.failed).toBe(1)
    // A row claiming an issue exists when it does not would suppress every future attempt.
    expect(
      await prisma.trackerIssue.findUnique({ where: { testIdentityId: identityId } }),
    ).toBeNull()
  })
})
