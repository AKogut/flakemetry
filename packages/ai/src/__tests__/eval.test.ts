import { describe, expect, it } from 'vitest'

import { compareToBaseline, type EvalCase, runEval, scoreAnalysis } from '../eval'
import type { LlmProvider } from '../provider'

const analysis = (over: Partial<Record<string, string>> = {}) => ({
  summary: over.summary ?? 'The orders endpoint rejects the payload',
  likelyCause: over.likelyCause ?? 'A missing idempotency header',
  suggestedAction: over.suggestedAction ?? 'Send the idempotency header in the fixture',
  confidence: 0.8,
})

describe('scoreAnalysis', () => {
  it('scores a full hit as one and a miss as zero', () => {
    const expectation = { causeKeywords: ['idempotency'], actionKeywords: ['header'] }

    expect(scoreAnalysis(analysis(), expectation).score).toBe(1)
    expect(
      scoreAnalysis(
        analysis({ summary: 'network', likelyCause: 'timeout', suggestedAction: 'retry' }),
        expectation,
      ).score,
    ).toBe(0)
  })

  it('counts an unparseable answer as unanswered rather than merely wrong', () => {
    // The two failures need different fixes — a prompt that stops producing JSON is a
    // different problem from one that produces a worse explanation.
    const score = scoreAnalysis(null, { causeKeywords: ['x'], actionKeywords: [] })
    expect(score.answered).toBe(false)
    expect(score.score).toBe(0)
  })

  it('is partial when only part of the expectation is met', () => {
    const score = scoreAnalysis(analysis(), {
      causeKeywords: ['idempotency', 'nonexistent'],
      actionKeywords: ['header'],
    })
    expect(score.causeRecall).toBe(0.5)
    expect(score.score).toBe(0.75)
  })
})

describe('runEval', () => {
  const provider = (text: string): LlmProvider => ({
    name: 'scripted',
    model: 'scripted',
    complete: async () => ({ text, inputTokens: 1, outputTokens: 1 }),
  })

  const cases: EvalCase[] = [
    {
      id: 'a',
      input: {
        testTitle: 'creates an order',
        suite: 'api',
        filePath: 'orders.spec.ts',
        error: { type: null, message: '422', stack: null },
      },
      expect: { causeKeywords: ['idempotency'], actionKeywords: [] },
    },
  ]

  it('aggregates the answered rate and mean score', async () => {
    const good = await runEval(provider(JSON.stringify(analysis())), cases, 'v2')
    expect(good.answeredRate).toBe(1)
    expect(good.meanScore).toBe(1)

    const garbage = await runEval(provider('not json'), cases, 'v2')
    expect(garbage.answeredRate).toBe(0)
    expect(garbage.meanScore).toBe(0)
  })
})

describe('compareToBaseline', () => {
  it('rejects a prompt that scores worse', () => {
    const gate = compareToBaseline(
      { meanScore: 0.8, answeredRate: 1 },
      { meanScore: 0.6, answeredRate: 1 },
    )
    expect(gate.passed).toBe(false)
    expect(gate.reasons[0]).toContain('mean score fell')
  })

  it('rejects a prompt that answers less often even at the same score', () => {
    const gate = compareToBaseline(
      { meanScore: 0.8, answeredRate: 1 },
      { meanScore: 0.8, answeredRate: 0.7 },
    )
    expect(gate.passed).toBe(false)
    expect(gate.reasons[0]).toContain('answered rate fell')
  })

  it('lets a tie through, so a change can be made on other grounds', () => {
    expect(
      compareToBaseline({ meanScore: 0.8, answeredRate: 1 }, { meanScore: 0.8, answeredRate: 1 })
        .passed,
    ).toBe(true)
  })

  it('accepts an improvement', () => {
    expect(
      compareToBaseline({ meanScore: 0.6, answeredRate: 0.9 }, { meanScore: 0.9, answeredRate: 1 })
        .passed,
    ).toBe(true)
  })
})
