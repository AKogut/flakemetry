import { PrismaClient } from '@flakemetry/db'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'

import { describeParams, getParamBuckets } from '../params'

const hasDb = Boolean(process.env.DATABASE_URL)
const prisma = new PrismaClient()

const SEEN = new Date('2026-07-20T10:00:00Z')
const DAY = new Date('2026-07-20T00:00:00Z')

describe('describeParams', () => {
  it('renders readable key/value pairs', () => {
    expect(describeParams({ browser: 'firefox', retries: 2 }, 'abcdef1234')).toBe(
      'browser="firefox", retries=2',
    )
  })

  it('falls back to a short hash when params are absent or empty', () => {
    expect(describeParams(null, 'abcdef1234567890')).toBe('abcdef12')
    expect(describeParams({}, 'abcdef1234567890')).toBe('abcdef12')
  })
})

describe.skipIf(!hasDb)('getParamBuckets', () => {
  beforeEach(async () => {
    await prisma.dailyTestStats.deleteMany()
    await prisma.flakyScore.deleteMany()
    await prisma.testIdentity.deleteMany()
    await prisma.project.deleteMany()
    await prisma.org.deleteMany()
  })

  afterAll(async () => {
    await prisma.$disconnect()
  })

  const seed = async () => {
    const org = await prisma.org.create({ data: { name: 'Acme', slug: `acme-${Date.now()}` } })
    const project = await prisma.project.create({
      data: { orgId: org.id, name: 'Web', slug: 'web' },
    })
    const tenant = { orgId: org.id, projectId: project.id }

    const makeVariant = async (
      hash: string,
      params: Record<string, string>,
      failed: number,
      score: number,
    ) => {
      const identity = await prisma.testIdentity.create({
        data: {
          ...tenant,
          fingerprint: `sha256:${hash}`,
          filePath: 'e2e/login.spec.ts',
          suite: 'auth',
          title: 'logs in',
          paramsHash: hash,
          params,
          firstSeenAt: SEEN,
          lastSeenAt: SEEN,
        },
      })
      await prisma.dailyTestStats.create({
        data: {
          ...tenant,
          testIdentityId: identity.id,
          day: DAY,
          total: 10,
          passed: 10 - failed,
          failed,
          flaky: 0,
          skipped: 0,
          avgDurationMs: 1000,
        },
      })
      await prisma.flakyScore.create({
        data: {
          ...tenant,
          testIdentityId: identity.id,
          score,
          flipRate: 0,
          passOnRerunRate: 0,
          sameShaVariance: 0,
          entropy: 0,
          failIsolation: 0,
          modelVersion: 'test',
          reasonCodes: [],
        },
      })
      return identity
    }

    const chrome = await makeVariant('hash-chrome', { browser: 'chrome' }, 0, 0.05)
    const firefox = await makeVariant('hash-firefox', { browser: 'firefox' }, 4, 0.7)
    return { projectId: project.id, chromeId: chrome.id, firefoxId: firefox.id }
  }

  it('groups sibling variants worst-first with a combined roll-up', async () => {
    const s = await seed()
    const group = await getParamBuckets(prisma, s.projectId, s.chromeId)

    expect(group).not.toBeNull()
    expect(group?.buckets).toHaveLength(2)
    expect(group?.buckets[0]?.id).toBe(s.firefoxId)
    expect(group?.buckets[0]?.label).toBe('browser="firefox"')
    expect(group?.buckets[0]?.failed).toBe(4)
    expect(group?.totals.total).toBe(20)
    expect(group?.totals.failed).toBe(4)
    expect(group?.totals.passRate).toBeCloseTo(0.8)
  })

  it('returns null for a test that is not parameterized', async () => {
    const org = await prisma.org.create({ data: { name: 'Solo', slug: `solo-${Date.now()}` } })
    const project = await prisma.project.create({
      data: { orgId: org.id, name: 'Web', slug: 'web' },
    })
    const identity = await prisma.testIdentity.create({
      data: {
        orgId: org.id,
        projectId: project.id,
        fingerprint: 'sha256:plain',
        filePath: 'e2e/a.spec.ts',
        suite: 'auth',
        title: 'plain',
        firstSeenAt: SEEN,
        lastSeenAt: SEEN,
      },
    })

    expect(await getParamBuckets(prisma, project.id, identity.id)).toBeNull()
  })
})
