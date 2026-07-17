import { describe, expect, it } from 'vitest'

import { computeFlakyScore, type ExecutionPoint, type ScoringConfig } from '../scoring'

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
  })

  it('bounds the scoring window to the most recent executions', () => {
    const ancient = Array.from({ length: 3 }, (_, i) => red('old', 300 + i))
    const recent = Array.from({ length: 4 }, (_, i) => green(`new${i}`, i))
    const result = computeFlakyScore([...ancient, ...recent], { ...config, windowSize: 4 })
    expect(result.sampleSize).toBe(4)
    expect(result.reasonCodes[0]?.code).toBe('STABLE')
  })
})
