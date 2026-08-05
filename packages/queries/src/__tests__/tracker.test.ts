import { describe, expect, it } from 'vitest'

import {
  planTrackerSync,
  renderTrackerIssue,
  TRACKER_MARKER,
  type TrackerCandidate,
} from '../tracker'

const NOW = new Date('2026-08-05T12:00:00Z')
const POLICY = { afterDays: 3, recoveryDays: 7 }

const daysAgo = (days: number): Date => new Date(NOW.getTime() - days * 24 * 60 * 60 * 1000)

const candidate = (over: Partial<TrackerCandidate> = {}): TrackerCandidate => ({
  testIdentityId: 'test-1',
  title: 'logs in',
  suite: 'auth',
  filePath: 'e2e/login.spec.ts',
  score: 0.86,
  flaky: true,
  flakySince: daysAgo(5),
  stableSince: null,
  issue: null,
  ...over,
})

describe('planTrackerSync', () => {
  it('opens one issue for a flake that has persisted past the policy', () => {
    const actions = planTrackerSync([candidate()], POLICY, NOW)

    expect(actions).toHaveLength(1)
    expect(actions[0]?.kind).toBe('open')
  })

  it('waits out the policy before filing', () => {
    // A test that flakes once on a bad afternoon should not earn a ticket.
    const actions = planTrackerSync([candidate({ flakySince: daysAgo(1) })], POLICY, NOW)

    expect(actions).toEqual([])
  })

  it('never files a second issue for a test that already has one', () => {
    const actions = planTrackerSync(
      [candidate({ issue: { externalId: '7', url: 'u', state: 'open', lastScore: 0.86 } })],
      POLICY,
      NOW,
    )

    // Duplicate tickets for one flake are the failure mode people actually notice.
    expect(actions).toEqual([])
  })

  it('reopens the same issue instead of filing a new one when a flake returns', () => {
    const actions = planTrackerSync(
      [candidate({ issue: { externalId: '7', url: 'u', state: 'closed', lastScore: 0.4 } })],
      POLICY,
      NOW,
    )

    expect(actions[0]?.kind).toBe('reopen')
    expect(actions[0]).toMatchObject({ externalId: '7' })
  })

  it('closes the issue once the test has stayed stable long enough', () => {
    const actions = planTrackerSync(
      [
        candidate({
          flaky: false,
          flakySince: null,
          stableSince: daysAgo(8),
          issue: { externalId: '7', url: 'u', state: 'open', lastScore: 0.86 },
        }),
      ],
      POLICY,
      NOW,
    )

    expect(actions[0]?.kind).toBe('close')
  })

  it('does not close on the first good day', () => {
    const actions = planTrackerSync(
      [
        candidate({
          flaky: false,
          flakySince: null,
          stableSince: daysAgo(2),
          issue: { externalId: '7', url: 'u', state: 'open', lastScore: 0.86 },
        }),
      ],
      POLICY,
      NOW,
    )

    expect(actions).toEqual([])
  })

  it('leaves an already closed issue alone', () => {
    const actions = planTrackerSync(
      [
        candidate({
          flaky: false,
          flakySince: null,
          stableSince: daysAgo(30),
          issue: { externalId: '7', url: 'u', state: 'closed', lastScore: 0.2 },
        }),
      ],
      POLICY,
      NOW,
    )

    expect(actions).toEqual([])
  })

  it('comments only when the score has actually moved', () => {
    const still = planTrackerSync(
      [
        candidate({
          score: 0.87,
          issue: { externalId: '7', url: 'u', state: 'open', lastScore: 0.86 },
        }),
      ],
      POLICY,
      NOW,
    )
    const moved = planTrackerSync(
      [
        candidate({
          score: 0.6,
          issue: { externalId: '7', url: 'u', state: 'open', lastScore: 0.86 },
        }),
      ],
      POLICY,
      NOW,
    )

    // An hourly sweep that comments every pass turns the issue into a firehose nobody reads.
    expect(still).toEqual([])
    expect(moved[0]?.kind).toBe('update')
  })

  it('ignores a test that is flaky but has no recorded spell', () => {
    const actions = planTrackerSync([candidate({ flakySince: null })], POLICY, NOW)

    expect(actions).toEqual([])
  })
})

describe('renderTrackerIssue', () => {
  const evidence = {
    reasonCodes: [{ code: 'PASS_ON_RERUN', message: 'passed on rerun in 85% of retried runs' }],
    owner: '@acme/web',
    topError: 'Timeout 30000ms exceeded',
    rcaSummary: 'The login button is clicked before hydration finishes.',
    history: [
      { day: new Date('2026-08-04'), flaky: 1, total: 4 },
      { day: new Date('2026-08-05'), flaky: 3, total: 4 },
    ],
    dashboardUrl: 'https://flakemetry.example/projects/p/tests/t',
  }

  it('carries the evidence rather than only a link to it', () => {
    const body = renderTrackerIssue(candidate(), evidence)

    // Whoever picks the ticket up should not need a dashboard account to know what it is.
    expect(body).toContain('PASS_ON_RERUN')
    expect(body).toContain('Timeout 30000ms exceeded')
    expect(body).toContain('hydration')
    expect(body).toContain('@acme/web')
    expect(body).toContain('0.86')
    expect(body).toContain(evidence.dashboardUrl)
  })

  it('carries a marker so the issue can be recognised later', () => {
    expect(renderTrackerIssue(candidate(), evidence)).toContain(TRACKER_MARKER)
  })

  it('renders without optional evidence', () => {
    const body = renderTrackerIssue(candidate(), {
      reasonCodes: [],
      owner: null,
      topError: null,
      rcaSummary: null,
      history: [],
      dashboardUrl: null,
    })

    expect(body).toContain('logs in')
    expect(body).not.toContain('undefined')
    expect(body).not.toContain('null')
  })

  it('truncates a huge error instead of posting the whole log', () => {
    const body = renderTrackerIssue(candidate(), { ...evidence, topError: 'x'.repeat(5000) })

    expect(body.length).toBeLessThan(2500)
  })
})
