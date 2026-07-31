import { describe, expect, it } from 'vitest'

import {
  bucketWeekly,
  type HealthEventPoint,
  median,
  pairFlakeResolutions,
  summarizeMttr,
  weekStartUtc,
} from '../health'

const at = (iso: string): Date => new Date(iso)

const event = (
  testIdentityId: string,
  kind: HealthEventPoint['kind'],
  iso: string,
): HealthEventPoint => ({ testIdentityId, kind, createdAt: at(iso) })

describe('weekStartUtc', () => {
  it('snaps any day to the preceding Monday at UTC midnight', () => {
    expect(weekStartUtc(at('2026-07-30T14:00:00Z')).toISOString()).toBe('2026-07-27T00:00:00.000Z')
    expect(weekStartUtc(at('2026-07-27T00:00:00Z')).toISOString()).toBe('2026-07-27T00:00:00.000Z')
    expect(weekStartUtc(at('2026-07-26T23:59:59Z')).toISOString()).toBe('2026-07-20T00:00:00.000Z')
  })
})

describe('median', () => {
  it('returns null for an empty set and the middle for odd/even', () => {
    expect(median([])).toBeNull()
    expect(median([5])).toBe(5)
    expect(median([1, 3, 2])).toBe(2)
    expect(median([1, 2, 3, 4])).toBe(2.5)
  })
})

describe('pairFlakeResolutions', () => {
  it('pairs each flaked with the next stabilized per test and counts open flakes', () => {
    const events: HealthEventPoint[] = [
      event('a', 'flaked', '2026-07-01T00:00:00Z'),
      event('a', 'stabilized', '2026-07-03T00:00:00Z'),
      event('b', 'flaked', '2026-07-05T00:00:00Z'),
      event('a', 'flaked', '2026-07-10T00:00:00Z'),
    ]
    const paired = pairFlakeResolutions(events)
    expect(paired.resolutions).toHaveLength(1)
    expect(paired.resolutions[0]!.flakedAt.toISOString()).toBe('2026-07-01T00:00:00.000Z')
    expect(paired.resolutions[0]!.resolvedAt.toISOString()).toBe('2026-07-03T00:00:00.000Z')
    // b never stabilized and a re-flaked without a later stabilize → two open flakes.
    expect(paired.openCount).toBe(2)
  })

  it('ignores duplicate flaked events and a stabilized with no open flake', () => {
    const events: HealthEventPoint[] = [
      event('a', 'stabilized', '2026-07-01T00:00:00Z'),
      event('a', 'flaked', '2026-07-02T00:00:00Z'),
      event('a', 'flaked', '2026-07-03T00:00:00Z'),
      event('a', 'stabilized', '2026-07-06T00:00:00Z'),
    ]
    const paired = pairFlakeResolutions(events)
    expect(paired.resolutions).toHaveLength(1)
    expect(paired.resolutions[0]!.flakedAt.toISOString()).toBe('2026-07-02T00:00:00.000Z')
    expect(paired.openCount).toBe(0)
  })
})

describe('summarizeMttr', () => {
  it('summarizes only resolutions that land within the window', () => {
    const paired = {
      resolutions: [
        { flakedAt: at('2026-06-01T00:00:00Z'), resolvedAt: at('2026-06-03T00:00:00Z') }, // 2d, before window
        { flakedAt: at('2026-07-01T00:00:00Z'), resolvedAt: at('2026-07-05T00:00:00Z') }, // 4d, in window
      ],
      openCount: 1,
    }
    const summary = summarizeMttr(paired, at('2026-06-15T00:00:00Z'))
    expect(summary.resolvedCount).toBe(1)
    expect(summary.openCount).toBe(1)
    expect(summary.medianMs).toBe(4 * 24 * 60 * 60 * 1000)
  })

  it('reports nulls when nothing resolved in the window', () => {
    const summary = summarizeMttr({ resolutions: [], openCount: 0 }, at('2026-07-01T00:00:00Z'))
    expect(summary.resolvedCount).toBe(0)
    expect(summary.meanMs).toBeNull()
    expect(summary.medianMs).toBeNull()
  })
})

describe('bucketWeekly', () => {
  it('buckets introduced and resolved counts into ISO weeks within the window', () => {
    const windowStart = at('2026-07-01T00:00:00Z')
    const now = at('2026-07-14T00:00:00Z')
    const events: HealthEventPoint[] = [
      event('a', 'flaked', '2026-07-02T00:00:00Z'), // week of Jun 29
      event('b', 'flaked', '2026-07-03T00:00:00Z'), // week of Jun 29
      event('a', 'stabilized', '2026-07-08T00:00:00Z'), // week of Jul 6
      event('c', 'flaked', '2026-06-20T00:00:00Z'), // before window → ignored
    ]
    const weekly = bucketWeekly(events, windowStart, now)
    const firstWithData = weekly.find((week) => week.introduced > 0 || week.resolved > 0)
    expect(firstWithData?.introduced).toBe(2)
    expect(firstWithData?.resolved).toBe(0)
    const total = weekly.reduce((sum, week) => sum + week.introduced + week.resolved, 0)
    expect(total).toBe(3)
  })
})
