import { describe, expect, it } from 'vitest'

import { summarizeAiSpend } from '../usage'

describe('summarizeAiSpend', () => {
  it('reports a budget of 0 as analysis being off, the way the worker treats it', () => {
    const spend = summarizeAiSpend(0, 0, 0)

    expect(spend.analysisOff).toBe(true)
    expect(spend.exhausted).toBe(false)
    expect(spend.fraction).toBeNull()
  })

  it('reports the share of a real budget and when it runs out', () => {
    expect(summarizeAiSpend(50_000, 200_000, 3)).toMatchObject({
      fraction: 0.25,
      exhausted: false,
      analysisOff: false,
    })
    expect(summarizeAiSpend(200_000, 200_000, 9)).toMatchObject({
      exhausted: true,
      analysisOff: false,
    })
  })
})
