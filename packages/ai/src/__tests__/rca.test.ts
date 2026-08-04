import { describe, expect, it, vi } from 'vitest'

import type { LlmProvider } from '../provider'
import { analyzeFailure, buildRcaPrompt, MAX_PRIOR_ANALYSES, parseRcaAnalysis } from '../rca'

const fakeProvider = (text: string, usage = { input: 100, output: 40 }): LlmProvider => ({
  name: 'fake',
  model: 'fake-model',
  complete: vi.fn(async () => ({ text, inputTokens: usage.input, outputTokens: usage.output })),
})

const input = {
  testTitle: 'logs in',
  suite: 'auth',
  filePath: 'e2e/login.spec.ts',
  error: { type: 'TimeoutError', message: 'Timeout for andrii@example.com', stack: null },
}

describe('buildRcaPrompt', () => {
  it('scrubs PII from the error before it reaches the model', () => {
    const prompt = buildRcaPrompt(input)
    expect(prompt).toContain('[REDACTED_EMAIL]')
    expect(prompt).not.toContain('andrii@example.com')
    expect(prompt).toContain('e2e/login.spec.ts')
  })
})

describe('parseRcaAnalysis', () => {
  const valid = JSON.stringify({
    summary: 's',
    likelyCause: 'c',
    suggestedAction: 'a',
    confidence: 0.7,
  })

  it('parses a bare JSON object', () => {
    expect(parseRcaAnalysis(valid)?.confidence).toBe(0.7)
  })

  it('extracts JSON wrapped in prose or fences', () => {
    expect(parseRcaAnalysis('Here you go:\n```json\n' + valid + '\n```')?.summary).toBe('s')
  })

  it('returns null on malformed or schema-invalid output', () => {
    expect(parseRcaAnalysis('not json')).toBeNull()
    expect(parseRcaAnalysis('{"summary":"s"}')).toBeNull()
    expect(
      parseRcaAnalysis('{"summary":"s","likelyCause":"c","suggestedAction":"a","confidence":9}'),
    ).toBeNull()
  })
})

describe('analyzeFailure', () => {
  it('returns the analysis, model and summed token cost', async () => {
    const provider = fakeProvider(
      '{"summary":"flaky network","likelyCause":"slow upstream","suggestedAction":"add retry","confidence":0.6}',
    )
    const outcome = await analyzeFailure(provider, input)
    expect(outcome).toMatchObject({ model: 'fake-model', tokenCost: 140 })
    expect(outcome?.analysis.likelyCause).toBe('slow upstream')
  })

  it('returns null when the model output cannot be parsed', async () => {
    expect(await analyzeFailure(fakeProvider('sorry, no idea'), input)).toBeNull()
  })
})

describe('grounding the prompt in earlier failures', () => {
  const input = {
    testTitle: 'creates an order',
    suite: 'api',
    filePath: 'e2e/orders.spec.ts',
    error: { type: 'Error', message: '422 Unprocessable Entity', stack: null },
  }

  it('puts prior causes and their resolutions in front of the model', () => {
    const prompt = buildRcaPrompt({
      ...input,
      similarPast: [
        { summary: 'Orders API rejects the payload', resolution: 'Send the idempotency header' },
      ],
    })

    expect(prompt).toContain('Orders API rejects the payload')
    expect(prompt).toContain('Send the idempotency header')
  })

  it('says nothing about history when there is none', () => {
    expect(buildRcaPrompt(input)).not.toContain('Earlier failures')
  })

  it('caps how much history it will carry', () => {
    const many = Array.from({ length: 10 }, (_, index) => ({
      summary: `cause ${index}`,
      resolution: `fix ${index}`,
    }))
    const prompt = buildRcaPrompt({ ...input, similarPast: many })

    expect(prompt).toContain(`cause ${MAX_PRIOR_ANALYSES - 1}`)
    expect(prompt).not.toContain(`cause ${MAX_PRIOR_ANALYSES}`)
  })

  it('reports how many past analyses the answer was grounded in', async () => {
    const provider = {
      name: 'fake',
      model: 'fake-model',
      complete: async () => ({
        text: '{"summary":"s","likelyCause":"c","suggestedAction":"a","confidence":0.7}',
        inputTokens: 10,
        outputTokens: 5,
      }),
    }

    const withHistory = await analyzeFailure(provider, {
      ...input,
      similarPast: [{ summary: 'a', resolution: 'b' }],
    })
    const without = await analyzeFailure(provider, input)

    expect(withHistory?.groundedIn).toBe(1)
    expect(without?.groundedIn).toBe(0)
  })
})
