import { describe, expect, it } from 'vitest'

import { resolveRunDuration, type RunDurationEvidence } from '../runs'

const evidence = (over: Partial<RunDurationEvidence>): RunDurationEvidence => ({
  starts: 1,
  totalMs: 0,
  longestMs: 0,
  spanMs: 0,
  ...over,
})

describe('resolveRunDuration', () => {
  it('keeps a stored duration when there is no reason to doubt it', () => {
    expect(resolveRunDuration(5000, undefined)).toEqual({
      durationMs: 5000,
      durationEstimated: false,
    })
  })

  it('replaces a stored duration shorter than a test in the run', () => {
    expect(
      resolveRunDuration(4, evidence({ starts: 9, totalMs: 4000, longestMs: 800, spanMs: 17_600 })),
    ).toEqual({ durationMs: 17_600, durationEstimated: false })
  })

  it('adds up test durations when no test has its own start', () => {
    expect(
      resolveRunDuration(null, evidence({ totalMs: 90_000, longestMs: 2000, spanMs: 2000 })),
    ).toEqual({ durationMs: 90_000, durationEstimated: true })
  })

  it('leaves a run with no measured test unknown', () => {
    expect(resolveRunDuration(null, evidence({ longestMs: 0, totalMs: 0 }))).toEqual({
      durationMs: null,
      durationEstimated: false,
    })
    expect(resolveRunDuration(null, undefined)).toEqual({
      durationMs: null,
      durationEstimated: false,
    })
  })
})
