import { PrismaClient } from '@flakemetry/db'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'

import {
  applyHistoricalRestitch,
  pairRestitchCandidates,
  planHistoricalRestitch,
  type RestitchIdentity,
} from '../restitch'

const hasDb = Boolean(process.env.DATABASE_URL)
const prisma = new PrismaClient()

const at = (iso: string): Date => new Date(iso)

const identity = (
  id: string,
  title: string,
  firstSeen: string,
  lastSeen: string,
  overrides: Partial<RestitchIdentity> = {},
): RestitchIdentity => ({
  id,
  filePath: 'e2e/login.spec.ts',
  suite: 'auth',
  title,
  paramsHash: null,
  firstSeenAt: at(firstSeen),
  lastSeenAt: at(lastSeen),
  ...overrides,
})

describe('pairRestitchCandidates', () => {
  it('pairs a retired test with the similar one that replaced it', () => {
    const pairs = pairRestitchCandidates([
      identity('old', 'logs in', '2026-01-01T00:00:00Z', '2026-06-01T00:00:00Z'),
      identity('new', 'logs in successfully', '2026-06-02T00:00:00Z', '2026-07-01T00:00:00Z'),
    ])

    expect(pairs).toHaveLength(1)
    expect(pairs[0]?.sourceIdentityId).toBe('old')
    expect(pairs[0]?.targetIdentityId).toBe('new')
    expect(pairs[0]?.fromTitle).toBe('logs in')
  })

  it('leaves tests that were alive at the same time alone', () => {
    const pairs = pairRestitchCandidates([
      identity('a', 'logs in', '2026-01-01T00:00:00Z', '2026-07-01T00:00:00Z'),
      identity('b', 'logs in successfully', '2026-06-01T00:00:00Z', '2026-07-01T00:00:00Z'),
    ])
    expect(pairs).toEqual([])
  })

  it('leaves unrelated titles and other buckets alone', () => {
    const pairs = pairRestitchCandidates([
      identity('old', 'logs in', '2026-01-01T00:00:00Z', '2026-06-01T00:00:00Z'),
      identity('other', 'renders the dashboard', '2026-06-02T00:00:00Z', '2026-07-01T00:00:00Z'),
      identity(
        'elsewhere',
        'logs in successfully',
        '2026-06-02T00:00:00Z',
        '2026-07-01T00:00:00Z',
        {
          filePath: 'e2e/other.spec.ts',
        },
      ),
    ])
    expect(pairs).toEqual([])
  })

  it('refuses an ambiguous predecessor', () => {
    const pairs = pairRestitchCandidates([
      identity('old-a', 'logs in ok', '2026-01-01T00:00:00Z', '2026-06-01T00:00:00Z'),
      identity('old-b', 'logs in now', '2026-01-01T00:00:00Z', '2026-06-01T00:00:00Z'),
      identity('new', 'logs in', '2026-06-02T00:00:00Z', '2026-07-01T00:00:00Z'),
    ])
    expect(pairs).toEqual([])
  })

  it('skips chains rather than guessing, so one identity is never claimed twice', () => {
    const pairs = pairRestitchCandidates([
      identity('v1', 'logs in', '2026-01-01T00:00:00Z', '2026-03-01T00:00:00Z'),
      identity('v2', 'logs in successfully', '2026-03-02T00:00:00Z', '2026-05-01T00:00:00Z'),
      identity('v3', 'logs in successfully now', '2026-05-02T00:00:00Z', '2026-07-01T00:00:00Z'),
    ])
    for (const pair of pairs) {
      expect(pair.sourceIdentityId).not.toBe(pair.targetIdentityId)
    }
    const claimed = pairs.flatMap((pair) => [pair.sourceIdentityId, pair.targetIdentityId])
    expect(new Set(claimed).size).toBe(claimed.length)
  })

  it('honours a stricter confidence floor', () => {
    const loose = pairRestitchCandidates([
      identity('old', 'logs in', '2026-01-01T00:00:00Z', '2026-06-01T00:00:00Z'),
      identity('new', 'logs in successfully', '2026-06-02T00:00:00Z', '2026-07-01T00:00:00Z'),
    ])
    const strict = pairRestitchCandidates(
      [
        identity('old', 'logs in', '2026-01-01T00:00:00Z', '2026-06-01T00:00:00Z'),
        identity('new', 'logs in successfully', '2026-06-02T00:00:00Z', '2026-07-01T00:00:00Z'),
      ],
      0.95,
    )
    expect(loose).toHaveLength(1)
    expect(strict).toEqual([])
  })
})

describe.skipIf(!hasDb)('applyHistoricalRestitch', () => {
  beforeEach(async () => {
    await prisma.identityMerge.deleteMany()
    await prisma.identityChange.deleteMany()
    await prisma.identityStitch.deleteMany()
    await prisma.testHealthEvent.deleteMany()
    await prisma.dailyTestStats.deleteMany()
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

  const seed = async () => {
    const org = await prisma.org.create({ data: { name: 'Acme', slug: `acme-${Date.now()}` } })
    const project = await prisma.project.create({
      data: { orgId: org.id, name: 'Web', slug: 'web' },
    })
    const tenant = { orgId: org.id, projectId: project.id }

    const make = (fingerprint: string, title: string, first: Date, last: Date) =>
      prisma.testIdentity.create({
        data: {
          ...tenant,
          fingerprint,
          filePath: 'e2e/login.spec.ts',
          suite: 'auth',
          title,
          firstSeenAt: first,
          lastSeenAt: last,
        },
      })

    const old = await make(
      'sha256:old',
      'logs in',
      at('2026-01-01T00:00:00Z'),
      at('2026-06-01T00:00:00Z'),
    )
    const fresh = await make(
      'sha256:new',
      'logs in successfully',
      at('2026-06-02T00:00:00Z'),
      at('2026-07-01T00:00:00Z'),
    )
    // An unrelated test that must be left alone.
    const other = await make(
      'sha256:other',
      'renders the dashboard',
      at('2026-01-01T00:00:00Z'),
      at('2026-07-01T00:00:00Z'),
    )

    return {
      orgId: org.id,
      projectId: project.id,
      oldId: old.id,
      freshId: fresh.id,
      otherId: other.id,
    }
  }

  it('re-links a plan and records each one as an undoable, audited merge', async () => {
    const s = await seed()

    const plan = await planHistoricalRestitch(prisma, s.projectId)
    expect(plan).toHaveLength(1)
    expect(plan[0]?.sourceIdentityId).toBe(s.oldId)
    expect(plan[0]?.targetIdentityId).toBe(s.freshId)

    const report = await applyHistoricalRestitch(prisma, s.orgId, s.projectId, plan)
    expect(report).toMatchObject({ planned: 1, restitched: 1 })
    expect(report.skipped).toEqual([])

    // The older identity is folded in; the unrelated test is untouched.
    expect(await prisma.testIdentity.findUnique({ where: { id: s.oldId } })).toBeNull()
    expect(await prisma.testIdentity.findUnique({ where: { id: s.otherId } })).not.toBeNull()

    const survivor = await prisma.testIdentity.findUniqueOrThrow({ where: { id: s.freshId } })
    expect(survivor.aliases).toContain('sha256:old')

    // Audited as a re-stitch rather than a hand-made merge, and undoable.
    const audit = await prisma.identityChange.findFirstOrThrow()
    expect(audit.action).toBe('restitch')
    expect(await prisma.identityMerge.count({ where: { undoneAt: null } })).toBe(1)
  })

  it('re-running finds nothing left to do', async () => {
    const s = await seed()
    await applyHistoricalRestitch(
      prisma,
      s.orgId,
      s.projectId,
      await planHistoricalRestitch(prisma, s.projectId),
    )

    expect(await planHistoricalRestitch(prisma, s.projectId)).toEqual([])
  })
})
