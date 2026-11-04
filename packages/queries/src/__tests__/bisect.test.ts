import { randomUUID } from 'node:crypto'

import { createPrismaClient } from '@flakemetry/db'
import { afterAll, describe, expect, it } from 'vitest'

import {
  type BisectPoint,
  explainBisect,
  findFlakeOnset,
  getFlakeBisect,
  MIN_STABLE_RUNS,
  rankSuspects,
} from '../bisect'

const hasDb = Boolean(process.env.DATABASE_URL)
const prisma = createPrismaClient()

const START = new Date('2026-07-01T00:00:00Z')
const HOUR = 60 * 60 * 1000

const point = (index: number, status: string, commitSha = `c${index}`): BisectPoint => ({
  runId: `run-${index}`,
  commitSha,
  branch: 'main',
  startedAt: new Date(START.getTime() + index * HOUR),
  status,
})

const greenThen = (green: number, ...rest: string[]): BisectPoint[] => [
  ...Array.from({ length: green }, (_, index) => point(index, 'pass')),
  ...rest.map((status, offset) => point(green + offset, status)),
]

describe('findFlakeOnset', () => {
  it('finds the first failure that follows a long green streak', () => {
    const window = findFlakeOnset(greenThen(8, 'fail'))

    expect(window?.firstBadRun.commitSha).toBe('c8')
    expect(window?.lastGoodRun?.commitSha).toBe('c7')
    expect(window?.stableRunsBefore).toBe(8)
  })

  it('treats a flaky result as an onset, not only an outright failure', () => {
    expect(findFlakeOnset(greenThen(6, 'flaky'))?.firstBadRun.status).toBe('flaky')
  })

  it('declines to name an onset for a test that was never reliable', () => {
    // Alternating from the start: whatever commit sits at the edge of retained history is
    // not the cause, and naming it would be a confident wrong answer.
    const history = Array.from({ length: 20 }, (_, index) =>
      point(index, index % 2 === 0 ? 'pass' : 'fail'),
    )

    expect(findFlakeOnset(history)).toBeNull()
  })

  it('requires the streak to be long enough', () => {
    expect(findFlakeOnset(greenThen(MIN_STABLE_RUNS - 1, 'fail'))).toBeNull()
    expect(findFlakeOnset(greenThen(MIN_STABLE_RUNS, 'fail'))).not.toBeNull()
  })

  it('ignores an early wobble and finds the later onset', () => {
    const history = [
      point(0, 'pass'),
      point(1, 'fail'),
      ...Array.from({ length: 7 }, (_, index) => point(index + 2, 'pass')),
      point(9, 'fail'),
    ]

    expect(findFlakeOnset(history)?.firstBadRun.commitSha).toBe('c9')
  })

  it('takes the last green run from a pass, not from a skip that followed it', () => {
    const history = [...greenThen(6), point(6, 'skip', 'skipped'), point(7, 'fail', 'skipped')]

    expect(findFlakeOnset(history)?.lastGoodRun?.commitSha).toBe('c5')
  })

  it('returns nothing for a test that has never failed', () => {
    expect(findFlakeOnset(greenThen(10))).toBeNull()
  })

  it('does not depend on the order it is handed', () => {
    const history = greenThen(8, 'fail')
    const shuffled = [...history].reverse()

    expect(findFlakeOnset(shuffled)?.firstBadRun.commitSha).toBe(
      findFlakeOnset(history)?.firstBadRun.commitSha,
    )
  })
})

describe('rankSuspects', () => {
  const window = {
    firstBadRun: point(10, 'fail', 'bad'),
    lastGoodRun: point(6, 'pass', 'good'),
    stableRunsBefore: 6,
  }

  it('includes commits the project ran in the window, newest first', () => {
    const runs = [point(7, 'pass', 'a'), point(8, 'pass', 'b'), point(10, 'pass', 'bad')]

    const suspects = rankSuspects(window, runs)

    // A suite does not run every test on every commit, so the window has to be filled from
    // the project's runs rather than this test's own history.
    expect(suspects.map((suspect) => suspect.commitSha)).toEqual(['bad', 'b', 'a'])
    expect(suspects[0]?.distance).toBe(0)
  })

  it('excludes the last green commit — it demonstrably passed', () => {
    const suspects = rankSuspects(window, [point(6, 'pass', 'good'), point(10, 'pass', 'bad')])

    expect(suspects.map((suspect) => suspect.commitSha)).toEqual(['bad'])
  })

  it('excludes anything after the failure', () => {
    const suspects = rankSuspects(window, [point(10, 'pass', 'bad'), point(12, 'pass', 'later')])

    expect(suspects.map((suspect) => suspect.commitSha)).not.toContain('later')
  })

  it('excludes the last green commit even when it ran again inside the window', () => {
    const suspects = rankSuspects(window, [point(8, 'pass', 'good'), point(10, 'pass', 'bad')])

    expect(suspects.map((suspect) => suspect.commitSha)).toEqual(['bad'])
  })

  it('counts a commit once however many runs it produced', () => {
    const suspects = rankSuspects(window, [
      point(8, 'pass', 'b'),
      point(9, 'pass', 'b'),
      point(10, 'pass', 'bad'),
    ])

    expect(suspects).toHaveLength(2)
  })
})

describe('explainBisect', () => {
  const window = {
    firstBadRun: point(10, 'fail', 'bad'),
    lastGoodRun: point(9, 'pass', 'good'),
    stableRunsBefore: 9,
  }
  const suspect = (sha: string, distance: number) => ({
    commitSha: sha,
    runId: 'r',
    startedAt: START,
    distance,
  })

  it('says identified only when one commit is in the window', () => {
    expect(explainBisect(window, [suspect('bad', 0)], true, true).verdict).toBe('identified')
  })

  it('names no suspect when the first failure is on the last green commit', () => {
    const sameCommit = {
      firstBadRun: point(10, 'fail', 'same'),
      lastGoodRun: point(9, 'pass', 'same'),
      stableRunsBefore: 9,
    }

    const result = explainBisect(sameCommit, [suspect('other', 0)], true, true)

    expect(result.verdict).toBe('no-code-change')
    expect(result.suspects).toEqual([])
    expect(result.reason).toContain('same commit')
  })

  it('says narrowed for a handful', () => {
    const result = explainBisect(window, [suspect('a', 0), suspect('b', 1)], true, true)

    expect(result.verdict).toBe('narrowed')
    expect(result.reason).toContain('2 commits')
  })

  it('refuses to name a suspect when the window is too wide', () => {
    const many = Array.from({ length: 40 }, (_, index) => suspect(`c${index}`, index))

    const result = explainBisect(window, many, true, true)

    // Thirty-nine wrong answers and one right one is not an answer.
    expect(result.verdict).toBe('inconclusive')
    expect(result.suspects.length).toBeLessThanOrEqual(10)
  })

  it('distinguishes never-failed from always-flaky', () => {
    expect(explainBisect(null, [], false, true).reason).toContain('not failed')
    expect(explainBisect(null, [], true, true).reason).toContain('unreliable')
  })

  it('does not say a test never failed when its failures were set aside', () => {
    const result = explainBisect(null, [], false, true, 3)

    expect(result.verdict).toBe('inconclusive')
    expect(result.reason).toContain('set aside')
    expect(result.reason).not.toContain('not failed')
  })
})

describe.skipIf(!hasDb)('getFlakeBisect', () => {
  afterAll(async () => {
    await prisma.$disconnect()
  })

  it('names the commit that introduced a seeded regression', async () => {
    const slug = `bisect-${randomUUID().slice(0, 8)}`
    const org = await prisma.org.create({ data: { name: slug, slug } })
    const project = await prisma.project.create({ data: { orgId: org.id, name: slug, slug } })
    const tenant = { orgId: org.id, projectId: project.id }
    const identity = await prisma.testIdentity.create({
      data: { ...tenant, fingerprint: randomUUID(), filePath: 'a.spec.ts', suite: 's', title: 't' },
    })

    // Eight clean runs, then the culprit lands and the test starts failing.
    for (let index = 0; index < 10; index += 1) {
      const startedAt = new Date(START.getTime() + index * HOUR)
      const run = await prisma.run.create({
        data: {
          ...tenant,
          idempotencyKey: `${slug}-${index}`,
          commitSha: `commit${index}`,
          branch: 'main',
          ciProvider: 'local',
          trigger: 'manual',
          status: 'passed',
          startedAt,
        },
      })
      await prisma.testExecution.create({
        data: {
          ...tenant,
          runId: run.id,
          ordinal: 0,
          testIdentityId: identity.id,
          attempt: 1,
          status: index < 8 ? 'pass' : 'fail',
          durationMs: 100,
          startedAt,
        },
      })
    }

    const bisect = await getFlakeBisect(prisma, project.id, identity.id)

    expect(bisect.verdict).toBe('identified')
    expect(bisect.suspects[0]?.commitSha).toBe('commit8')
    expect(bisect.window?.lastGoodRun?.commitSha).toBe('commit7')
    expect(bisect.reason).toContain('8 run(s) in a row')
  })

  const seedHistory = async (
    commits: {
      sha: string
      status: 'pass' | 'fail'
      othersFailing?: number
      othersPassing?: number
    }[],
  ) => {
    const slug = `bisect-${randomUUID().slice(0, 8)}`
    const org = await prisma.org.create({ data: { name: slug, slug } })
    const project = await prisma.project.create({ data: { orgId: org.id, name: slug, slug } })
    const tenant = { orgId: org.id, projectId: project.id }
    const createIdentity = (title: string) =>
      prisma.testIdentity.create({
        data: { ...tenant, fingerprint: randomUUID(), filePath: 'a.spec.ts', suite: 's', title },
      })
    const identity = await createIdentity('t')

    for (const [index, commit] of commits.entries()) {
      const startedAt = new Date(START.getTime() + index * HOUR)
      const run = await prisma.run.create({
        data: {
          ...tenant,
          idempotencyKey: `${slug}-${index}`,
          commitSha: commit.sha,
          branch: 'main',
          ciProvider: 'local',
          trigger: 'manual',
          status: commit.status === 'pass' ? 'passed' : 'failed',
          startedAt,
          passedCount: (commit.status === 'pass' ? 1 : 0) + (commit.othersPassing ?? 0),
        },
      })
      const execution = { ...tenant, runId: run.id, attempt: 1, durationMs: 100, startedAt }
      await prisma.testExecution.create({
        data: { ...execution, ordinal: 0, testIdentityId: identity.id, status: commit.status },
      })
      for (let other = 0; other < (commit.othersFailing ?? 0); other += 1) {
        const sibling = await createIdentity(`sibling-${index}-${other}`)
        await prisma.testExecution.create({
          data: { ...execution, ordinal: other + 1, testIdentityId: sibling.id, status: 'fail' },
        })
      }
    }

    return { projectId: project.id, identityId: identity.id }
  }

  const green = (count: number, sha: (index: number) => string) =>
    Array.from({ length: count }, (_, index) => ({ sha: sha(index), status: 'pass' as const }))

  it('names no commit when the test failed on the commit that last passed', async () => {
    const { projectId, identityId } = await seedHistory([
      ...green(6, () => 'nightly'),
      { sha: 'nightly', status: 'fail' },
    ])

    const bisect = await getFlakeBisect(prisma, projectId, identityId)

    expect(bisect.verdict).toBe('no-code-change')
    expect(bisect.suspects).toEqual([])
    expect(bisect.window?.lastGoodRun?.commitSha).toBe('nightly')
    expect(bisect.window?.firstBadRun.commitSha).toBe('nightly')
  })

  it('names no onset when the only failure came in a mass failure', async () => {
    const { projectId, identityId } = await seedHistory([
      ...green(6, (index) => `commit${index}`),
      { sha: 'outage', status: 'fail', othersFailing: 5 },
    ])

    const bisect = await getFlakeBisect(prisma, projectId, identityId)

    expect(bisect.verdict).toBe('inconclusive')
    expect(bisect.window).toBeNull()
    expect(bisect.suspects).toEqual([])
    expect(bisect.reason).toContain('set aside')
  })

  it('looks past a mass failure to a later failure of the test itself', async () => {
    const { projectId, identityId } = await seedHistory([
      ...green(6, (index) => `commit${index}`),
      { sha: 'outage', status: 'fail', othersFailing: 5 },
      { sha: 'recovered', status: 'pass' },
      { sha: 'culprit', status: 'fail', othersPassing: 20 },
    ])

    const bisect = await getFlakeBisect(prisma, projectId, identityId)

    expect(bisect.verdict).toBe('identified')
    expect(bisect.suspects.map((suspect) => suspect.commitSha)).toEqual(['culprit'])
    expect(bisect.window?.lastGoodRun?.commitSha).toBe('recovered')
    expect(bisect.window?.stableRunsBefore).toBe(7)
  })

  it('still names a commit when a failure among many passes is not a mass failure', async () => {
    const { projectId, identityId } = await seedHistory([
      ...green(6, (index) => `commit${index}`),
      { sha: 'culprit', status: 'fail', othersFailing: 5, othersPassing: 20 },
    ])

    const bisect = await getFlakeBisect(prisma, projectId, identityId)

    expect(bisect.verdict).toBe('identified')
    expect(bisect.suspects[0]?.commitSha).toBe('culprit')
  })

  it('stays silent for a test that was always flaky', async () => {
    const slug = `bisect-${randomUUID().slice(0, 8)}`
    const org = await prisma.org.create({ data: { name: slug, slug } })
    const project = await prisma.project.create({ data: { orgId: org.id, name: slug, slug } })
    const tenant = { orgId: org.id, projectId: project.id }
    const identity = await prisma.testIdentity.create({
      data: { ...tenant, fingerprint: randomUUID(), filePath: 'a.spec.ts', suite: 's', title: 't' },
    })

    for (let index = 0; index < 12; index += 1) {
      const startedAt = new Date(START.getTime() + index * HOUR)
      const run = await prisma.run.create({
        data: {
          ...tenant,
          idempotencyKey: `${slug}-${index}`,
          commitSha: `commit${index}`,
          branch: 'main',
          ciProvider: 'local',
          trigger: 'manual',
          status: 'passed',
          startedAt,
        },
      })
      await prisma.testExecution.create({
        data: {
          ...tenant,
          runId: run.id,
          ordinal: 0,
          testIdentityId: identity.id,
          attempt: 1,
          status: index % 2 === 0 ? 'pass' : 'fail',
          durationMs: 100,
          startedAt,
        },
      })
    }

    const bisect = await getFlakeBisect(prisma, project.id, identity.id)

    expect(bisect.verdict).toBe('inconclusive')
    expect(bisect.suspects).toEqual([])
  })
})
