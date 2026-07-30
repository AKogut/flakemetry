import { describe, expect, it } from 'vitest'

import { isSuiteDurationRegressed, isSuiteRegressed } from '../trends'

const day = (total: number, failed: number, flaky = 0) => ({ total, failed, flaky })

const dday = (total: number, avgDurationMs: number) => ({ total, avgDurationMs })

describe('isSuiteRegressed', () => {
  it('flags a suite whose latest day jumps above its pooled baseline', () => {
    expect(isSuiteRegressed([day(40, 0), day(40, 1), day(40, 20)])).toBe(true)
  })

  it('ignores a latest day below the minimum sample size', () => {
    expect(isSuiteRegressed([day(40, 0), day(5, 5)])).toBe(false)
  })

  it('ignores a jump under the delta threshold', () => {
    expect(isSuiteRegressed([day(40, 4), day(40, 8)])).toBe(false)
  })

  it('needs a qualifying prior day', () => {
    expect(isSuiteRegressed([day(5, 0), day(40, 30)])).toBe(false)
    expect(isSuiteRegressed([day(40, 30)])).toBe(false)
  })
})

describe('isSuiteDurationRegressed', () => {
  it('flags a suite that got materially slower', () => {
    expect(isSuiteDurationRegressed([dday(40, 1000), dday(40, 1600)])).toBe(true)
  })

  it('ignores a modest slowdown, a fast suite, or a low-volume latest day', () => {
    expect(isSuiteDurationRegressed([dday(40, 1000), dday(40, 1200)])).toBe(false)
    expect(isSuiteDurationRegressed([dday(40, 100), dday(40, 400)])).toBe(false)
    expect(isSuiteDurationRegressed([dday(40, 1000), dday(5, 5000)])).toBe(false)
  })
})
