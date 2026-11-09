import { randomUUID } from 'node:crypto'

import { countStatuses, createPrismaClient, runCountFields } from '@flakemetry/db'
import { afterAll, describe, expect, it } from 'vitest'

import { getFlakeBisect } from '../bisect'
import { failureSetAside, loadRunFailures } from '../run-failures'
import { computeIdentityScores } from '../scoring'
import { getTestCaseMatrix } from '../test-cases'

const hasDb = Boolean(process.env.DATABASE_URL)
const prisma = createPrismaClient()
const NOW = new Date('2026-09-20T12:00:00Z')
const OUTAGE_ERROR = 'AssertionError: expected 500 to be 200 // Object.is equality'

interface Outcome {
  test: number
  status: 'fail' | 'flaky' | 'pass'
  attempt?: number
  message?: string
}

const seedSuite = async (size: number) => {
  const slug = `shared-${randomUUID().slice(0, 8)}`
  const org = await prisma.org.create({ data: { name: slug, slug } })
  const project = await prisma.project.create({ data: { orgId: org.id, name: slug, slug } })
  const tenant = { orgId: org.id, projectId: project.id }

  const tests: string[] = []
  for (let index = 0; index < size; index += 1) {
    const identity = await prisma.testIdentity.create({
      data: {
        ...tenant,
        fingerprint: `fp-${index}-${slug}`,
        filePath: 'api.spec.ts',
        suite: 'api',
        title: `TC-API-${String(index).padStart(3, '0')} a test`,
        params: { variant: 'live' },
        firstSeenAt: NOW,
        lastSeenAt: NOW,
      },
    })
    tests.push(identity.id)
  }

  let runs = 0
  const addRun = async (sha: string, outcomes: readonly Outcome[] = []): Promise<string> => {
    runs += 1
    const startedAt = new Date(NOW.getTime() + runs * 3_600_000)
    const named = new Set(outcomes.map((outcome) => outcome.test))
    const passing = tests.flatMap((_, test) =>
      named.has(test) ? [] : [{ test, status: 'pass' as const }],
    )
    const executions = [...outcomes, ...passing]
    const run = await prisma.run.create({
      data: {
        ...tenant,
        idempotencyKey: `run-${runs}-${slug}`,
        commitSha: sha,
        branch: 'main',
        ciProvider: 'github_actions',
        trigger: 'schedule',
        status: outcomes.some((outcome) => outcome.status === 'fail') ? 'failed' : 'passed',
        startedAt,
        ...runCountFields(countStatuses(executions.map((execution) => execution.status))),
        storedExecutions: executions.length,
      },
    })
    await prisma.testExecution.createMany({
      data: executions.map((execution, ordinal) => ({
        ...tenant,
        runId: run.id,
        testIdentityId: tests[execution.test] as string,
        ordinal,
        attempt: 'attempt' in execution ? (execution.attempt ?? 1) : 1,
        status: execution.status,
        errorMessage: 'message' in execution ? (execution.message ?? null) : null,
        durationMs: 10,
        startedAt,
      })),
    })
    return run.id
  }

  return { ...tenant, tests, addRun }
}

const failing = (count: number, message = OUTAGE_ERROR, from = 0): Outcome[] =>
  Array.from({ length: count }, (_, index) => ({
    test: from + index,
    status: 'fail' as const,
    message,
  }))

describe.skipIf(!hasDb)('failures that many tests share in one run', () => {
  afterAll(async () => {
    await prisma.$disconnect()
  })

  const verdictOf = async (
    suite: Awaited<ReturnType<typeof seedSuite>>,
    runId: string,
    test: number,
  ) =>
    failureSetAside(
      await loadRunFailures(prisma, suite.projectId, [runId]),
      runId,
      suite.tests[test] as string,
    )

  it('sets them aside when the same commit passed before', async () => {
    const suite = await seedSuite(20)
    await suite.addRun('nightly')
    const outage = await suite.addRun('nightly', failing(6))

    expect(await verdictOf(suite, outage, 0)).toBe('shared')
    expect(await verdictOf(suite, outage, 6)).toBeNull()
  })

  it('sets them aside once the same commit passes again', async () => {
    const suite = await seedSuite(20)
    const outage = await suite.addRun('nightly', failing(6))
    expect(await verdictOf(suite, outage, 0)).toBeNull()

    await suite.addRun('nightly')
    expect(await verdictOf(suite, outage, 0)).toBe('shared')
  })

  it('reads different numbers in one error as the same error', async () => {
    const suite = await seedSuite(20)
    await suite.addRun('nightly')
    const outage = await suite.addRun('nightly', [
      ...failing(3, 'AssertionError: expected 500 to be 200 // Object.is equality'),
      ...failing(3, 'AssertionError: expected 403 to be 202 // Object.is equality', 3),
    ])

    expect(await verdictOf(suite, outage, 0)).toBe('shared')
    expect(await verdictOf(suite, outage, 5)).toBe('shared')
  })

  it('leaves another error in that run counted', async () => {
    const suite = await seedSuite(20)
    await suite.addRun('nightly')
    const outage = await suite.addRun('nightly', [
      ...failing(6),
      ...failing(1, 'Error: Test timed out in 45000ms.', 6),
    ])

    expect(await verdictOf(suite, outage, 6)).toBeNull()
  })

  it('keeps counting a bug that fails the same tests on every run of its commit', async () => {
    const suite = await seedSuite(20)
    await suite.addRun('before-the-bug')
    const first = await suite.addRun('the-bug', failing(6))
    const second = await suite.addRun('the-bug', failing(6))
    await suite.addRun('the-fix')

    expect(await verdictOf(suite, first, 0)).toBeNull()
    expect(await verdictOf(suite, second, 0)).toBeNull()
  })

  it('decides per test, so a test that never passed on that commit stays counted', async () => {
    const suite = await seedSuite(20)
    await suite.addRun('nightly', failing(1, 'Error: only this test', 0))
    const outage = await suite.addRun('nightly', failing(6))

    expect(await verdictOf(suite, outage, 0)).toBeNull()
    expect(await verdictOf(suite, outage, 1)).toBe('shared')
  })

  it('keeps counting failures a retry rescued in the same run', async () => {
    const suite = await seedSuite(53)
    await suite.addRun('nightly')
    const rescued = await suite.addRun(
      'nightly',
      Array.from({ length: 6 }, (_, test) => [
        { test, status: 'fail' as const, attempt: 1, message: 'Add task form did not open' },
        { test, status: 'flaky' as const, attempt: 2 },
      ]).flat(),
    )

    expect(await verdictOf(suite, rescued, 0)).toBeNull()
  })

  it('keeps counting four tests that fail alike', async () => {
    const suite = await seedSuite(144)
    await suite.addRun('nightly')
    const run = await suite.addRun('nightly', failing(4, 'expected 404 to be 200'))

    expect(await verdictOf(suite, run, 0)).toBeNull()
  })

  it('keeps counting a cluster that is a small part of a large suite', async () => {
    const suite = await seedSuite(61)
    await suite.addRun('nightly')
    const run = await suite.addRun('nightly', failing(6))

    expect(await verdictOf(suite, run, 0)).toBeNull()
  })

  it('still reports a run where most of the suite failed as a mass failure', async () => {
    const suite = await seedSuite(10)
    await suite.addRun('nightly')
    const crash = await suite.addRun('nightly', failing(8))

    expect(await verdictOf(suite, crash, 0)).toBe('mass')
  })

  it('takes a test off the board and leaves its flake on another night counted', async () => {
    const suite = await seedSuite(20)
    await suite.addRun('nightly')
    await suite.addRun('nightly', failing(6))
    await suite.addRun('nightly', failing(1, 'Error: only this test', 1))
    await suite.addRun('nightly')

    const scored = await computeIdentityScores(
      prisma,
      suite.orgId,
      suite.projectId,
      [suite.tests[0] as string, suite.tests[1] as string],
      { now: new Date(NOW.getTime() + 100 * 3_600_000) },
    )

    const onlyInOutage = scored.get(suite.tests[0] as string)
    expect(onlyInOutage?.result.sameShaVariance).toBe(0)
    expect(onlyInOutage?.result.flipRate).toBe(0)
    expect(onlyInOutage?.result.reasonCodes.map((reason) => reason.code)).toEqual([
      'SHARED_FAILURES_SET_ASIDE',
    ])
    expect(onlyInOutage?.data.lastFlakedAt).toBeNull()

    const alsoFlaked = scored.get(suite.tests[1] as string)
    expect(alsoFlaked?.result.score).toBeGreaterThan(0)
    expect(alsoFlaked?.result.reasonCodes.map((reason) => reason.code)).toEqual(
      expect.arrayContaining(['SAME_SHA_VARIANCE', 'SHARED_FAILURES_SET_ASIDE']),
    )
    expect(alsoFlaked?.data.lastFlakedAt).not.toBeNull()
  })

  it('names no onset when the only failure came in such a run', async () => {
    const suite = await seedSuite(20)
    for (let night = 0; night < 6; night += 1) await suite.addRun('nightly')
    await suite.addRun('nightly', failing(6))
    await suite.addRun('nightly')

    const bisect = await getFlakeBisect(prisma, suite.projectId, suite.tests[0] as string)

    expect(bisect.window).toBeNull()
    expect(bisect.reason).toContain('set aside')
  })

  it('still names an onset for a bug that keeps failing on its commit', async () => {
    const suite = await seedSuite(20)
    for (let night = 0; night < 6; night += 1) await suite.addRun(`commit-${night}`)
    await suite.addRun('the-bug', failing(6))

    const bisect = await getFlakeBisect(prisma, suite.projectId, suite.tests[0] as string)

    expect(bisect.window?.firstBadRun.commitSha).toBe('the-bug')
  })

  it('leaves those failures out of the test case matrix, as the score does', async () => {
    const suite = await seedSuite(20)
    await suite.addRun('nightly')
    await suite.addRun('nightly', [
      ...failing(6),
      ...failing(1, 'Error: Test timed out in 45000ms.', 6),
    ])

    const matrix = await getTestCaseMatrix(prisma, suite.projectId)
    const cell = (id: string) =>
      matrix.cases.find((row) => row.caseId === id)?.cells.find((item) => item.variant === 'live')

    expect(cell('TC-API-000')).toMatchObject({ passed: 1, failed: 0 })
    expect(cell('TC-API-006')).toMatchObject({ passed: 1, failed: 1 })
  })

  it('returns nothing when asked about no runs', async () => {
    const suite = await seedSuite(1)
    expect(await loadRunFailures(prisma, suite.projectId, [])).toEqual(new Map())
  })
})
