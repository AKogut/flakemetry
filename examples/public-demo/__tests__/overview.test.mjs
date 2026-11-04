import { describe, expect, it } from 'vitest'

import { renderOverview } from '../lib/overview.mjs'

const PROJECTS = ['playwright', 'restful-booker', 'mobile', 'flakemetry'].map((slug) => ({
  slug,
  projectId: slug,
  name: `${slug} suite`,
  repo: `AKogut/${slug}`,
  summary: 'A suite.',
}))

const at = (date) => ({ startedAt: new Date(date) })
const FIRST = at('2026-08-06T05:00:00Z')
const LAST = at('2026-11-04T05:00:00Z')
const NO_TESTS = ['2026-10-24T08:00:00Z', '2026-10-26T08:00:00Z', '2026-10-26T09:00:00Z'].map(at)

const runRow = (variant, status) => ({
  id: `${variant}-${status}`,
  variant,
  status,
  storedExecutions: 1,
  passedCount: 1,
  failedCount: 0,
  flakyCount: 0,
})

const OUTAGE = { id: 'outage', passedCount: 106, failedCount: 22, flakyCount: 0 }
const FAILED_THAT_NIGHT = ['a', 'b', 'c'].map((testIdentityId) => ({ testIdentityId }))

const fakePrisma = ({ runCount = 3, first = FIRST, last = LAST, outage = OUTAGE } = {}) => ({
  run: {
    count: async () => runCount,
    findFirst: async ({ orderBy }) => {
      if (!orderBy) return outage
      return orderBy.startedAt === 'asc' ? first : last
    },
    findMany: async ({ where }) => {
      if (where.status !== 'failed') {
        return [runRow('appium-ios', 'canceled'), runRow('appium-ios', 'failed')]
      }
      return where.projectId === 'restful-booker' ? NO_TESTS : []
    },
  },
  testExecution: {
    count: async () => 1,
    groupBy: async () => [],
    findMany: async ({ where }) =>
      where.runId === 'outage' ? FAILED_THAT_NIGHT : [{ testIdentityId: 'c' }],
  },
  testIdentity: { count: async () => 1, findMany: async () => [] },
  flakyScore: { findMany: async () => [] },
})

const text = (html) => html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ')
const rowOf = (html, label) =>
  text(new RegExp(`<tr><td>${label}</td>(.*?)</tr>`).exec(html)[1])
    .trim()
    .split(' ')

describe('renderOverview', () => {
  it('says "1 run" and not "1 runs"', async () => {
    const page = text(await renderOverview(fakePrisma({ runCount: 1 }), PROJECTS))
    expect(page).toContain('1 run ')
    expect(page).not.toContain('1 runs')
  })

  it('shows one date when a project has one day of history', async () => {
    const page = text(await renderOverview(fakePrisma({ first: LAST, last: LAST }), PROJECTS))
    expect(page).toContain('Nov 4, 2026.')
    expect(page).not.toContain('to Nov 4, 2026')
  })

  it('shows a range otherwise', async () => {
    const page = text(await renderOverview(fakePrisma(), PROJECTS))
    expect(page).toContain('Aug 6, 2026 to Nov 4, 2026.')
  })

  it('counts runs and nights apart for the runs where no test ran', async () => {
    const page = text(await renderOverview(fakePrisma(), PROJECTS))
    expect(page).toContain('3 runs on 2 nights so far')
  })

  it('states that a pass on a reconstructed green night is inferred', async () => {
    const page = text(await renderOverview(fakePrisma(), PROJECTS))
    expect(page).toContain('the pass of each test is inferred')
    expect(page).not.toContain('which test passed or failed on which night is real')
  })

  it('does not claim that every outage is set aside', async () => {
    const page = text(await renderOverview(fakePrisma(), PROJECTS))
    expect(page).not.toContain('An outage is not a flake')
    expect(page).toContain('A partial outage gets past that gate')
    expect(page).toContain('On Aug 31 the hosted platform failed 22 of the 128 tests that ran')
    expect(page).toContain('For 2 of them it is the only failure on record')
  })

  it('leaves the partial outage out when that run is not in the history', async () => {
    const page = text(await renderOverview(fakePrisma({ outage: null }), PROJECTS))
    expect(page).not.toContain('A partial outage gets past that gate')
  })

  it('sends readers to a page that links to tests, not to the runs', async () => {
    const html = await renderOverview(fakePrisma(), PROJECTS)
    expect(html).toContain('<a href="playwright/flaky.html">the board</a>')
    expect(text(html)).not.toContain('then a test to see')
  })

  it('keeps a cancelled job out of the red count and says what it means', async () => {
    const html = await renderOverview(fakePrisma(), PROJECTS)
    expect(rowOf(html, 'Cancelled before it finished')).toEqual(['0', '1', '0', '0'])
    expect(rowOf(html, 'Went red')).toEqual(['0', '1', '0', '0'])
    expect(text(html)).toContain('A cancelled job was stopped before it finished')
  })

  it('does not count the suites in its description', async () => {
    expect(await renderOverview(fakePrisma(), PROJECTS)).not.toContain('three public')
  })
})
