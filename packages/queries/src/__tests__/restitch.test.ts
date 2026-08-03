import { describe, expect, it } from 'vitest'

import { pairRestitchCandidates, type RestitchIdentity } from '../restitch'

const at = (iso: string): Date => new Date(iso)

const identity = (
  id: string,
  title: string,
  firstSeen: string,
  lastSeen: string,
  overrides: Partial<RestitchIdentity> = {},
): RestitchIdentity => ({
  id,
  filePath: 'e2e/login.spec.ts',
  suite: 'auth',
  title,
  paramsHash: null,
  firstSeenAt: at(firstSeen),
  lastSeenAt: at(lastSeen),
  ...overrides,
})

describe('pairRestitchCandidates', () => {
  it('pairs a retired test with the similar one that replaced it', () => {
    const pairs = pairRestitchCandidates([
      identity('old', 'logs in', '2026-01-01T00:00:00Z', '2026-06-01T00:00:00Z'),
      identity('new', 'logs in successfully', '2026-06-02T00:00:00Z', '2026-07-01T00:00:00Z'),
    ])

    expect(pairs).toHaveLength(1)
    expect(pairs[0]?.sourceIdentityId).toBe('old')
    expect(pairs[0]?.targetIdentityId).toBe('new')
    expect(pairs[0]?.fromTitle).toBe('logs in')
  })

  it('leaves tests that were alive at the same time alone', () => {
    const pairs = pairRestitchCandidates([
      identity('a', 'logs in', '2026-01-01T00:00:00Z', '2026-07-01T00:00:00Z'),
      identity('b', 'logs in successfully', '2026-06-01T00:00:00Z', '2026-07-01T00:00:00Z'),
    ])
    expect(pairs).toEqual([])
  })

  it('leaves unrelated titles and other buckets alone', () => {
    const pairs = pairRestitchCandidates([
      identity('old', 'logs in', '2026-01-01T00:00:00Z', '2026-06-01T00:00:00Z'),
      identity('other', 'renders the dashboard', '2026-06-02T00:00:00Z', '2026-07-01T00:00:00Z'),
      identity(
        'elsewhere',
        'logs in successfully',
        '2026-06-02T00:00:00Z',
        '2026-07-01T00:00:00Z',
        {
          filePath: 'e2e/other.spec.ts',
        },
      ),
    ])
    expect(pairs).toEqual([])
  })

  it('refuses an ambiguous predecessor', () => {
    const pairs = pairRestitchCandidates([
      identity('old-a', 'logs in ok', '2026-01-01T00:00:00Z', '2026-06-01T00:00:00Z'),
      identity('old-b', 'logs in now', '2026-01-01T00:00:00Z', '2026-06-01T00:00:00Z'),
      identity('new', 'logs in', '2026-06-02T00:00:00Z', '2026-07-01T00:00:00Z'),
    ])
    expect(pairs).toEqual([])
  })

  it('skips chains rather than guessing, so one identity is never claimed twice', () => {
    const pairs = pairRestitchCandidates([
      identity('v1', 'logs in', '2026-01-01T00:00:00Z', '2026-03-01T00:00:00Z'),
      identity('v2', 'logs in successfully', '2026-03-02T00:00:00Z', '2026-05-01T00:00:00Z'),
      identity('v3', 'logs in successfully now', '2026-05-02T00:00:00Z', '2026-07-01T00:00:00Z'),
    ])
    for (const pair of pairs) {
      expect(pair.sourceIdentityId).not.toBe(pair.targetIdentityId)
    }
    const claimed = pairs.flatMap((pair) => [pair.sourceIdentityId, pair.targetIdentityId])
    expect(new Set(claimed).size).toBe(claimed.length)
  })

  it('honours a stricter confidence floor', () => {
    const loose = pairRestitchCandidates([
      identity('old', 'logs in', '2026-01-01T00:00:00Z', '2026-06-01T00:00:00Z'),
      identity('new', 'logs in successfully', '2026-06-02T00:00:00Z', '2026-07-01T00:00:00Z'),
    ])
    const strict = pairRestitchCandidates(
      [
        identity('old', 'logs in', '2026-01-01T00:00:00Z', '2026-06-01T00:00:00Z'),
        identity('new', 'logs in successfully', '2026-06-02T00:00:00Z', '2026-07-01T00:00:00Z'),
      ],
      0.95,
    )
    expect(loose).toHaveLength(1)
    expect(strict).toEqual([])
  })
})
