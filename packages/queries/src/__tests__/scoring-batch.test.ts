import { randomUUID } from 'node:crypto'

import { createPrismaClient } from '@flakemetry/db'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { computeIdentityScore, computeIdentityScores } from '../scoring'

const hasDb = Boolean(process.env.DATABASE_URL)
const prisma = createPrismaClient()
const NOW = new Date('2026-08-18T12:00:00Z')

interface Seeded {
  orgId: string
  projectId: string
  identityIds: string[]
}

/**
 * Deliberately uneven: a test with a long history, one that flakes, one that was only ever
 * seen once, and one with no executions at all. A batched loader that quietly drops the
 * empty case, or mixes two identities' windows together, passes on a uniform fixture.
 */
const seed = async (): Promise<Seeded> => {
  const slug = `batch-${randomUUID().slice(0, 8)}`
  const org = await prisma.org.create({ data: { name: slug, slug } })
  const project = await prisma.project.create({ data: { orgId: org.id, name: slug, slug } })
  const tenant = { orgId: org.id, projectId: project.id }

  const identityIds: string[] = []
  const shapes = [
    { name: 'stable', statuses: Array.from({ length: 30 }, () => 'pass' as const) },
    {
      name: 'flaky',
      statuses: Array.from({ length: 30 }, (_, i) =>
        i % 3 === 0 ? ('fail' as const) : ('pass' as const),
      ),
    },
    { name: 'once', statuses: ['fail' as const] },
    { name: 'never', statuses: [] },
  ]

  for (const shape of shapes) {
    const identity = await prisma.testIdentity.create({
      data: {
        ...tenant,
        fingerprint: `fp-${shape.name}-${slug}`,
        filePath: `e2e/${shape.name}.spec.ts`,
        suite: 'suite',
        title: shape.name,
        firstSeenAt: NOW,
        lastSeenAt: NOW,
      },
    })
    identityIds.push(identity.id)

    for (const [index, status] of shape.statuses.entries()) {
      const run = await prisma.run.create({
        data: {
          ...tenant,
          idempotencyKey: `${shape.name}-${index}-${slug}`,
          commitSha: `sha${index}`,
          branch: 'main',
          ciProvider: 'github_actions',
          ciRunId: `ci-${index}`,
          trigger: 'push',
          status: status === 'fail' ? 'failed' : 'passed',
          startedAt: new Date(NOW.getTime() - (shape.statuses.length - index) * 3_600_000),
        },
      })
      await prisma.testExecution.create({
        data: {
          ...tenant,
          runId: run.id,
          testIdentityId: identity.id,
          ordinal: 0,
          status,
          attempt: 1,
          durationMs: 100,
          startedAt: new Date(NOW.getTime() - (shape.statuses.length - index) * 3_600_000),
        },
      })
    }
  }

  return { orgId: org.id, projectId: project.id, identityIds }
}

describe.skipIf(!hasDb)('batched scoring', { timeout: 120_000 }, () => {
  let seeded: Seeded

  beforeAll(async () => {
    seeded = await seed()
  })

  afterAll(async () => {
    await prisma.$disconnect()
  })

  it('scores every identity it was asked about, including one with no history', async () => {
    const scored = await computeIdentityScores(
      prisma,
      seeded.orgId,
      seeded.projectId,
      seeded.identityIds,
      { now: NOW },
    )

    // A map keyed off the query result would silently omit the test that has never run,
    // and the caller would then never write a score for it.
    expect([...scored.keys()].sort()).toEqual([...seeded.identityIds].sort())
  })

  it('agrees with scoring one identity at a time, field for field', async () => {
    const batched = await computeIdentityScores(
      prisma,
      seeded.orgId,
      seeded.projectId,
      seeded.identityIds,
      { now: NOW },
    )

    for (const identityId of seeded.identityIds) {
      const single = await computeIdentityScore(
        prisma,
        seeded.orgId,
        seeded.projectId,
        identityId,
        {
          now: NOW,
        },
      )
      const fromBatch = batched.get(identityId)

      // Faster and different is a regression, not an optimisation.
      expect(fromBatch?.data).toEqual(single.data)
      expect(fromBatch?.result).toEqual(single.result)
      expect(fromBatch?.previousQuarantineCandidate).toBe(single.previousQuarantineCandidate)
      expect(fromBatch?.identity).toEqual(single.identity)
      expect(fromBatch?.executions.map((e) => [e.status, e.startedAt.toISOString()])).toEqual(
        single.executions.map((e) => [e.status, e.startedAt.toISOString()]),
      )
    }
  })

  it('keeps each identity history to itself', async () => {
    const scored = await computeIdentityScores(
      prisma,
      seeded.orgId,
      seeded.projectId,
      seeded.identityIds,
      { now: NOW },
    )
    const counts = seeded.identityIds.map((id) => scored.get(id)?.executions.length ?? -1)

    // One window bleeding into another is the failure mode a PARTITION BY has, and it
    // would raise every score rather than throwing.
    expect(counts).toEqual([30, 30, 1, 0])
  })

  it('returns an empty map rather than querying for nothing', async () => {
    expect(
      await computeIdentityScores(prisma, seeded.orgId, seeded.projectId, [], { now: NOW }),
    ).toEqual(new Map())
  })
})

describe.skipIf(!hasDb)('scoring a run where most of the suite failed', () => {
  const seedSuite = async (failingInSecondRun: number) => {
    const slug = `mass-${randomUUID().slice(0, 8)}`
    const org = await prisma.org.create({ data: { name: slug, slug } })
    const project = await prisma.project.create({ data: { orgId: org.id, name: slug, slug } })
    const tenant = { orgId: org.id, projectId: project.id }
    const TESTS = 8

    const identities = []
    for (let test = 0; test < TESTS; test += 1) {
      identities.push(
        await prisma.testIdentity.create({
          data: {
            ...tenant,
            fingerprint: `fp-${test}-${slug}`,
            filePath: `e2e/${test}.spec.ts`,
            suite: 'suite',
            title: `test ${test}`,
            firstSeenAt: NOW,
            lastSeenAt: NOW,
          },
        }),
      )
    }

    for (const [runIndex, failing] of [0, failingInSecondRun].entries()) {
      const startedAt = new Date(NOW.getTime() - (2 - runIndex) * 3_600_000)
      const run = await prisma.run.create({
        data: {
          ...tenant,
          idempotencyKey: `run-${runIndex}-${slug}`,
          commitSha: 'same-commit',
          branch: 'main',
          ciProvider: 'github_actions',
          ciRunId: `ci-${runIndex}-${slug}`,
          trigger: 'schedule',
          status: failing > 0 ? 'failed' : 'passed',
          startedAt,
          passedCount: TESTS - failing,
          failedCount: failing,
        },
      })
      for (const [index, identity] of identities.entries()) {
        await prisma.testExecution.create({
          data: {
            ...tenant,
            runId: run.id,
            testIdentityId: identity.id,
            ordinal: index,
            status: index < failing ? 'fail' : 'pass',
            attempt: 1,
            startedAt,
            durationMs: 10,
          },
        })
      }
    }
    return { ...tenant, ids: identities.map((identity) => identity.id) }
  }

  const scoreFirstTest = async (failingInSecondRun: number) => {
    const { orgId, projectId, ids } = await seedSuite(failingInSecondRun)
    const scored = await computeIdentityScores(prisma, orgId, projectId, ids, { now: NOW })
    return scored.get(ids[0] as string)
  }

  it('sets the failures aside and does not date the test as flaked', async () => {
    const scored = await scoreFirstTest(7)

    expect(scored?.result.sameShaVariance).toBe(0)
    expect(scored?.result.reasonCodes.map((reason) => reason.code)).toEqual([
      'MASS_FAILURES_SET_ASIDE',
    ])
    expect(scored?.data.lastFlakedAt).toBeNull()
  })

  it('keeps the evidence when only part of the suite failed', async () => {
    const scored = await scoreFirstTest(2)

    expect(scored?.result.sameShaVariance).toBe(1)
    expect(scored?.result.reasonCodes.map((reason) => reason.code)).toContain('SAME_SHA_VARIANCE')
    expect(scored?.data.lastFlakedAt).not.toBeNull()
  })
})
