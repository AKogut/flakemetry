import { describe, expect, it } from 'vitest'

import {
  isQuarantineDecision,
  MANUAL_QUARANTINE_REASON,
  planQuarantineWrite,
  type QuarantineState,
} from '../quarantine'

const NOW = new Date('2026-08-05T12:00:00Z')

const state = (over: Partial<QuarantineState> = {}): QuarantineState => ({
  quarantined: false,
  quarantineOverride: null,
  quarantineReason: null,
  ...over,
})

describe('isQuarantineDecision', () => {
  it('accepts the three decisions and nothing else', () => {
    expect(isQuarantineDecision('quarantined')).toBe(true)
    expect(isQuarantineDecision('released')).toBe(true)
    expect(isQuarantineDecision('auto')).toBe(true)
    expect(isQuarantineDecision('delete')).toBe(false)
    expect(isQuarantineDecision('')).toBe(false)
  })
})

describe('planQuarantineWrite', () => {
  it('records who decided and when, not just the new state', () => {
    const write = planQuarantineWrite(state(), 'quarantined', 'known bad', 'user-1', NOW)

    expect(write).toMatchObject({
      quarantined: true,
      quarantineOverride: 'quarantined',
      quarantineReason: 'known bad',
      quarantineOverrideBy: 'user-1',
      quarantineOverrideAt: NOW,
    })
  })

  it('marks a release as a decision too', () => {
    const write = planQuarantineWrite(
      state({ quarantined: true, quarantineReason: 'auto: flaky score above threshold' }),
      'released',
      null,
      'user-1',
      NOW,
    )

    // Releasing a test the scorer still considers flaky is exactly as much a decision as
    // quarantining a healthy one; without the override the next run undoes it.
    expect(write.quarantined).toBe(false)
    expect(write.quarantineOverride).toBe('released')
    expect(write.quarantineReason).toBeNull()
  })

  it('falls back to a reason rather than leaving the badge unexplained', () => {
    const write = planQuarantineWrite(state(), 'quarantined', '   ', 'user-1', NOW)

    expect(write.quarantineReason).toBe(MANUAL_QUARANTINE_REASON)
  })

  it('caps a reason that would not fit beside the test', () => {
    const write = planQuarantineWrite(state(), 'quarantined', 'x'.repeat(500), null, NOW)

    expect(write.quarantineReason).toHaveLength(200)
  })

  it('hands a test back without guessing what the scorer would say', () => {
    const write = planQuarantineWrite(
      state({ quarantined: true, quarantineOverride: 'quarantined', quarantineReason: 'manual' }),
      'auto',
      null,
      'user-1',
      NOW,
    )

    // The cooldown that decides when a quarantined test is safe to release lives in the
    // worker. Reimplementing it here would be a second copy of the rule, free to drift.
    expect(write.quarantined).toBe(true)
    expect(write.quarantineOverride).toBeNull()
    expect(write.quarantineOverrideBy).toBeNull()
    expect(write.quarantineOverrideAt).toBeNull()
  })

  it('clears the attribution when the scorer takes over again', () => {
    const write = planQuarantineWrite(
      state({ quarantineOverride: 'released' }),
      'auto',
      null,
      'user-2',
      NOW,
    )

    // Leaving a stale name on it would credit the next automatic change to a person who
    // did not make it.
    expect(write.quarantineOverrideBy).toBeNull()
  })
})
