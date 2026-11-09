import { describe, expect, it } from 'vitest'

import {
  computeFlakyScore,
  type ExecutionPoint,
  findSharedFailures,
  isMassFailureRun,
  type RunFailure,
  type ScoringConfig,
} from '../scoring'

const NOW = new Date('2026-07-16T12:00:00Z')
const config: ScoringConfig = { now: NOW, threshold: 0.8, minSamples: 5 }

const daysAgo = (days: number): Date => new Date(NOW.getTime() - days * 86_400_000)

const green = (commitSha: string, day: number, attempt = 1): ExecutionPoint => ({
  status: 'pass',
  commitSha,
  attempt,
  startedAt: daysAgo(day),
})
const red = (commitSha: string, day: number, attempt = 1): ExecutionPoint => ({
  status: 'fail',
  commitSha,
  attempt,
  startedAt: daysAgo(day),
})

describe('a run where most of the suite failed', () => {
  const nights = (count: number): ExecutionPoint[] =>
    Array.from({ length: count }, (_, day) => ({
      ...green('same-commit', day + 2),
      runId: `run-${day}`,
    }))
  const crash: ExecutionPoint = {
    ...red('same-commit', 1),
    runId: 'crash',
    inMassFailure: true,
  }

  it('is not evidence that a test is flaky', () => {
    const result = computeFlakyScore([...nights(20), crash], config)

    expect(result.sameShaVariance).toBe(0)
    expect(result.flipRate).toBe(0)
    expect(result.reasonCodes.map((reason) => reason.code)).toEqual(['MASS_FAILURES_SET_ASIDE'])
    expect(result.reasonCodes[0]?.message).toContain('1 failure(s) not counted')
  })

  it('leaves a test that failed alone with its score', () => {
    const alone: ExecutionPoint = { ...crash, inMassFailure: false }

    const withCrash = computeFlakyScore([...nights(20), crash], config)
    const withFlake = computeFlakyScore([...nights(20), alone], config)

    expect(withFlake.score).toBeGreaterThan(withCrash.score)
    expect(withFlake.reasonCodes.map((reason) => reason.code)).toContain('SAME_SHA_VARIANCE')
  })

  it('still counts a real flake that also went down with the suite', () => {
    const alone: ExecutionPoint = { ...red('same-commit', 3), runId: 'alone' }
    const result = computeFlakyScore([...nights(20), alone, crash], config)

    expect(result.reasonCodes.map((reason) => reason.code)).toEqual(
      expect.arrayContaining(['SAME_SHA_VARIANCE', 'MASS_FAILURES_SET_ASIDE']),
    )
  })

  it('explains a test seen only in such runs instead of calling it never executed', () => {
    const result = computeFlakyScore([crash], config)

    expect(result.score).toBe(0)
    expect(result.reasonCodes.map((reason) => reason.code)).toEqual(['MASS_FAILURES_SET_ASIDE'])
  })

  it.each([
    { failed: 46, executed: 49, mass: true },
    { failed: 5, executed: 10, mass: true },
    { failed: 5, executed: 11, mass: false },
    { failed: 4, executed: 4, mass: false },
    { failed: 22, executed: 271, mass: false },
    { failed: 0, executed: 0, mass: false },
  ])('$failed of $executed failing is mass: $mass', ({ failed, executed, mass }) => {
    expect(isMassFailureRun({ failed, executed })).toBe(mass)
  })
})

describe('failures that many tests share in one run', () => {
  const failing = (count: number, message: string | null, from = 0): RunFailure[] =>
    Array.from({ length: count }, (_, index) => ({
      testId: `test-${from + index}`,
      message,
      recoveredInRun: false,
    }))

  it('reads the same error with different numbers as one error', () => {
    const shared = findSharedFailures(
      [
        ...failing(14, 'AssertionError: expected 500 to be 200 // Object.is equality'),
        ...failing(5, 'AssertionError: expected 403 to be 202 // Object.is equality', 14),
        ...failing(1, 'Error: Test timed out in 45000ms.', 19),
      ],
      128,
    )

    expect(shared.size).toBe(19)
    expect(shared.has('test-19')).toBe(false)
  })

  it('needs at least 5 tests, so a handful of tests failing alike still counts', () => {
    expect(findSharedFailures(failing(4, 'expected 404 to be 200'), 20).size).toBe(0)
  })

  it('needs at least a tenth of what the run executed', () => {
    const six = failing(6, 'boom')
    expect(findSharedFailures(six, 61).size).toBe(0)
    expect(findSharedFailures(six, 60).size).toBe(6)
  })

  it('leaves out a test that a retry rescued in the same run', () => {
    const rescued = failing(6, 'Add task form did not open').map((failure) => ({
      ...failure,
      recoveredInRun: true,
    }))

    expect(findSharedFailures(rescued, 53).size).toBe(0)
  })

  it('does not pool failures that carry no message', () => {
    expect(findSharedFailures(failing(10, null), 20).size).toBe(0)
  })

  const nights = Array.from({ length: 20 }, (_, day) => ({
    ...green('same-commit', day + 2),
    runId: `run-${day}`,
  }))
  const outage: ExecutionPoint = {
    ...red('same-commit', 1),
    runId: 'outage',
    inSharedFailure: true,
  }

  it('is not evidence that a test is flaky, and says so', () => {
    const result = computeFlakyScore([...nights, outage], config)

    expect(result.score).toBe(computeFlakyScore(nights, config).score)
    expect(result.sameShaVariance).toBe(0)
    expect(result.reasonCodes.map((reason) => reason.code)).toEqual(['SHARED_FAILURES_SET_ASIDE'])
    expect(result.reasonCodes[0]?.message).toContain('1 failure(s) not counted')
  })

  it('keeps the evidence of a failure the test had on its own', () => {
    const alone: ExecutionPoint = { ...red('same-commit', 3), runId: 'alone' }
    const result = computeFlakyScore([...nights, alone, outage], config)

    expect(result.reasonCodes.map((reason) => reason.code)).toEqual(
      expect.arrayContaining(['SAME_SHA_VARIANCE', 'SHARED_FAILURES_SET_ASIDE']),
    )
    expect(result.score).toBeGreaterThan(computeFlakyScore(nights, config).score)
  })

  it('reports each kind of set-aside failure once when a test has both', () => {
    const crash: ExecutionPoint = { ...red('same-commit', 4), runId: 'crash', inMassFailure: true }
    const result = computeFlakyScore([...nights, crash, outage], config)

    expect(result.reasonCodes.map((reason) => reason.code)).toEqual([
      'MASS_FAILURES_SET_ASIDE',
      'SHARED_FAILURES_SET_ASIDE',
    ])
  })

  it('explains a test seen only in such a run instead of calling it never executed', () => {
    const result = computeFlakyScore([outage], config)

    expect(result.score).toBe(0)
    expect(result.reasonCodes.map((reason) => reason.code)).toEqual(['SHARED_FAILURES_SET_ASIDE'])
  })
})

describe('reason codes describe what happened', () => {
  const nightly = (
    status: ExecutionPoint['status'],
    day: number,
    runId: string,
  ): ExecutionPoint => ({
    status,
    commitSha: 'same-commit',
    attempt: 1,
    startedAt: daysAgo(day),
    runId,
  })

  it('does not call a failure one night and a pass the next a rerun', () => {
    const result = computeFlakyScore(
      [nightly('fail', 3, 'night-1'), nightly('pass', 2, 'night-2'), nightly('pass', 1, 'night-3')],
      config,
    )
    expect(result.passOnRerunRate).toBe(0)
    expect(result.reasonCodes.map((reason) => reason.code)).not.toContain('PASS_ON_RERUN')
    expect(result.reasonCodes.map((reason) => reason.code)).toContain('SAME_SHA_VARIANCE')
  })

  it('counts a rerun when a later attempt of one run recovers', () => {
    const result = computeFlakyScore(
      [
        { ...nightly('fail', 1, 'run-1'), attempt: 1 },
        { ...nightly('pass', 1, 'run-1'), attempt: 2 },
      ],
      config,
    )
    expect(result.passOnRerunRate).toBe(1)
    expect(result.reasonCodes.map((reason) => reason.code)).toContain('PASS_ON_RERUN')
  })

  it('reads one flaky row, which is how Vitest and Jest report a retry, as a recovered retry', () => {
    const result = computeFlakyScore(
      [nightly('flaky', 2, 'run-1'), { ...nightly('pass', 1, 'run-2'), commitSha: 'other' }],
      config,
    )
    expect(result.passOnRerunRate).toBe(1)
    expect(result.sameShaVariance).toBeGreaterThan(0)
    expect(result.reasonCodes.map((reason) => reason.code)).toEqual(
      expect.arrayContaining(['PASS_ON_RERUN', 'SAME_SHA_VARIANCE']),
    )
  })

  it('does not count a recovery twice when the failed attempt is also present', () => {
    const result = computeFlakyScore(
      [
        { ...nightly('fail', 1, 'run-1'), attempt: 1 },
        { ...nightly('flaky', 1, 'run-1'), attempt: 2 },
        { ...nightly('fail', 2, 'run-2'), attempt: 1 },
        { ...nightly('fail', 2, 'run-2'), attempt: 2 },
      ],
      config,
    )
    expect(result.passOnRerunRate).toBe(0.5)
  })

  it('scores a test that has only ever been skipped as zero and says so', () => {
    const history = Array.from({ length: 94 }, (_, day) => ({
      ...nightly('skip', day, `run-${day}`),
    }))
    const result = computeFlakyScore(history, config)
    expect(result.score).toBe(0)
    expect(result.sampleSize).toBe(0)
    expect(result.reasonCodes.map((reason) => reason.code)).toEqual(['NEVER_EXECUTED'])
  })

  it('does not call a test unstable when it has never failed', () => {
    const oldPasses = [nightly('pass', 400, 'run-1'), nightly('pass', 401, 'run-2')]
    const result = computeFlakyScore(oldPasses, config)
    expect(result.reasonCodes.map((reason) => reason.code)).toEqual(['STABLE'])
  })
})

describe('computeFlakyScore', () => {
  it('scores a consistently green test near zero and explains it as stable', () => {
    const history = Array.from({ length: 8 }, (_, i) => green(`sha${i}`, i))
    const result = computeFlakyScore(history, config)
    expect(result.score).toBeLessThan(0.15)
    expect(result.reasonCodes).toHaveLength(1)
    expect(result.reasonCodes[0]?.code).toBe('STABLE')
    expect(result.quarantineCandidate).toBe(false)
  })

  it('flags same-commit variance as the strongest signal with a reason code', () => {
    const history = [
      red('sha1', 1, 1),
      green('sha1', 1, 2),
      red('sha2', 2, 1),
      green('sha2', 2, 2),
      green('sha3', 3),
      green('sha4', 4),
    ]
    const result = computeFlakyScore(history, config)
    expect(result.sameShaVariance).toBeGreaterThan(0)
    expect(result.passOnRerunRate).toBeGreaterThan(0)
    expect(result.reasonCodes.map((r) => r.code)).toContain('SAME_SHA_VARIANCE')
    expect(result.reasonCodes.map((r) => r.code)).toContain('PASS_ON_RERUN')
    expect(result.score).toBeGreaterThan(0.3)
  })

  it('is deterministic for identical input', () => {
    const history = [red('a', 1), green('b', 2), red('c', 3), green('d', 4)]
    expect(computeFlakyScore(history, config)).toEqual(computeFlakyScore(history, config))
  })

  it('weights recent flakiness more than the same flakiness in the distant past', () => {
    const recent = [red('a', 1), green('a', 1, 2), green('b', 2), green('c', 3)]
    const old = [red('a', 200), green('a', 200, 2), green('b', 2), green('c', 3)]
    const recentScore = computeFlakyScore(recent, config).score
    const oldScore = computeFlakyScore(old, config).score
    expect(recentScore).toBeGreaterThan(oldScore)
  })

  it('marks a quarantine candidate only above threshold and sample size', () => {
    const flaky = [
      red('a', 1, 1),
      green('a', 1, 2),
      red('b', 2, 1),
      green('b', 2, 2),
      red('c', 3, 1),
      green('c', 3, 2),
    ]
    const result = computeFlakyScore(flaky, config)
    expect(result.quarantineCandidate).toBe(result.score >= 0.8 && result.sampleSize >= 5)

    const tooFew = computeFlakyScore(flaky.slice(0, 2), config)
    expect(tooFew.quarantineCandidate).toBe(false)
  })

  it('ignores skipped executions in the sample', () => {
    const history: ExecutionPoint[] = [
      { status: 'skip', commitSha: 'a', attempt: 1, startedAt: daysAgo(1) },
      green('b', 2),
      green('c', 3),
    ]
    expect(computeFlakyScore(history, config).sampleSize).toBe(2)
  })

  it('raises fail_isolation and a reason code when the test fails alone', () => {
    const isolated: ExecutionPoint[] = [
      { ...red('a', 4), runFailureCount: 1 },
      { ...red('b', 3), runFailureCount: 1 },
      { ...red('c', 2), runFailureCount: 1 },
      green('d', 1),
    ]
    const correlated: ExecutionPoint[] = [
      { ...red('a', 4), runFailureCount: 40 },
      { ...red('b', 3), runFailureCount: 35 },
      { ...red('c', 2), runFailureCount: 50 },
      green('d', 1),
    ]
    const isolatedResult = computeFlakyScore(isolated, config)
    const correlatedResult = computeFlakyScore(correlated, config)

    expect(isolatedResult.failIsolation).toBe(1)
    expect(correlatedResult.failIsolation).toBe(0)
    expect(isolatedResult.reasonCodes.map((r) => r.code)).toContain('FAIL_ISOLATION')
    expect(isolatedResult.score).toBeGreaterThan(correlatedResult.score)
  })

  it('folds entropy into the score for an evenly split history', () => {
    const balanced: ExecutionPoint[] = [
      red('a', 8),
      green('b', 7),
      red('c', 6),
      green('d', 5),
      red('e', 4),
      green('f', 3),
    ]
    const result = computeFlakyScore(balanced, config)
    expect(result.entropy).toBeGreaterThan(0.9)
    expect(result.score).toBeGreaterThan(0)
    expect(result.reasonCodes.map((r) => r.code)).toContain('MIXED_OUTCOMES')
  })

  it('explains a recently unstable test with a reason code', () => {
    const unstable: ExecutionPoint[] = [red('a', 4), red('b', 3), red('c', 2), green('d', 1)]
    const result = computeFlakyScore(unstable, config)
    expect(result.reasonCodes.map((r) => r.code)).toContain('RECENT_INSTABILITY')
  })

  it('bounds the scoring window to the most recent executions', () => {
    const ancient = Array.from({ length: 3 }, (_, i) => red('old', 300 + i))
    const recent = Array.from({ length: 4 }, (_, i) => green(`new${i}`, i))
    const result = computeFlakyScore([...ancient, ...recent], { ...config, windowSize: 4 })
    expect(result.sampleSize).toBe(4)
    expect(result.reasonCodes[0]?.code).toBe('STABLE')
  })
})
