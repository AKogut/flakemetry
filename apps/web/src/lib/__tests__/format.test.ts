import { describe, expect, it } from 'vitest'

import { formatPercent, formatTestDuration } from '../format'

describe('formatPercent', () => {
  it('does not round a small rate down to nothing', () => {
    expect(formatPercent(0.0043)).toBe('0.4%')
    expect(formatPercent(0.0002)).toBe('<0.1%')
  })

  it('does not round a suite with failures up to everything', () => {
    expect(formatPercent(0.9957)).toBe('99.6%')
    expect(formatPercent(0.99996)).toBe('>99.9%')
  })

  it('keeps whole percents in the ordinary range', () => {
    expect(formatPercent(0)).toBe('0%')
    expect(formatPercent(0.14)).toBe('14%')
    expect(formatPercent(0.88)).toBe('88%')
    expect(formatPercent(1)).toBe('100%')
  })

  it('has a placeholder for a rate that does not exist', () => {
    expect(formatPercent(null)).toBe('—')
  })
})

describe('formatTestDuration', () => {
  it('shows milliseconds under a second', () => {
    expect(formatTestDuration(23)).toBe('23ms')
    expect(formatTestDuration(999)).toBe('999ms')
  })

  it('shows seconds from a second up', () => {
    expect(formatTestDuration(1000)).toBe('1.0s')
    expect(formatTestDuration(61_500)).toBe('61.5s')
  })

  it('tells a measured instant from a missing duration', () => {
    expect(formatTestDuration(0)).toBe('<1ms')
    expect(formatTestDuration(null)).toBe('—')
  })
})
