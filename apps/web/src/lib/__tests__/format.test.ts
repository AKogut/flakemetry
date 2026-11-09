import { describe, expect, it } from 'vitest'

import {
  formatExecutionDuration,
  formatPercent,
  formatTestDuration,
  formatWhen,
  suiteName,
  testLocation,
} from '../format'

describe('formatExecutionDuration', () => {
  it('shows a measured duration', () => {
    expect(formatExecutionDuration({ status: 'pass', durationMs: 1234, durationKnown: true })).toBe(
      '1.2s',
    )
  })

  it('shows a real 0 from a timed run as under a millisecond', () => {
    expect(formatExecutionDuration({ status: 'pass', durationMs: 0, durationKnown: true })).toBe(
      '<1ms',
    )
  })

  it('says a duration is not known when the run measured none', () => {
    expect(formatExecutionDuration({ status: 'pass', durationMs: 0, durationKnown: false })).toBe(
      '—',
    )
  })

  it('does not time a skipped test', () => {
    expect(formatExecutionDuration({ status: 'skip', durationMs: 0, durationKnown: true })).toBe(
      '—',
    )
  })
})

describe('formatWhen', () => {
  it('prints UTC whatever the server time zone is', () => {
    expect(formatWhen(new Date('2026-11-04T23:30:00Z'))).toBe('Nov 4, 23:30')
    expect(formatWhen(new Date('2026-11-05T00:05:00+02:00'))).toBe('Nov 4, 22:05')
  })
})

describe('testLocation', () => {
  it('joins a suite and a path', () => {
    expect(testLocation('auth', 'e2e/login.spec.ts')).toBe('auth · e2e/login.spec.ts')
  })

  it('drops an empty suite', () => {
    expect(testLocation('', 'e2e/login.spec.ts')).toBe('e2e/login.spec.ts')
  })

  it('does not repeat a suite that is the path', () => {
    expect(testLocation('tests/a.test.ts', 'tests/a.test.ts')).toBe('tests/a.test.ts')
  })
})

describe('suiteName', () => {
  it('names a suite and says when there is none', () => {
    expect(suiteName('auth')).toBe('auth')
    expect(suiteName('')).toBe('No suite')
  })
})

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
