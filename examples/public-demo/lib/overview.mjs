import { findSharedFailures, isMassFailureRun } from '@flakemetry/core'

import { MOBILE_RUNNERS } from '../projects.mjs'
import { escapeHtml, testCaseIdOf } from './site.mjs'

const number = (value) => new Intl.NumberFormat('en').format(value)
const plural = (count, one, many = `${one}s`) => (count === 1 ? one : many)
const day = (date) =>
  new Intl.DateTimeFormat('en', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    timeZone: 'UTC',
  }).format(date)

const shortDay = (date) =>
  new Intl.DateTimeFormat('en', { month: 'short', day: 'numeric', timeZone: 'UTC' }).format(date)

const PARTIAL_OUTAGE_DAY = new Date('2026-08-31T00:00:00Z')

const dateRange = (first, last) => {
  const [from, to] = [day(first), day(last)]
  return from === to ? `${from}.` : `${from} to ${to}.`
}

const statsOf = async (prisma, project) => {
  const where = { projectId: project.projectId }
  const [runs, executions, tests, failedRuns, noTestRows, first, last, flaky, failing, scores] =
    await Promise.all([
      prisma.run.count({ where }),
      prisma.testExecution.count({ where }),
      prisma.testIdentity.count({ where }),
      prisma.run.count({ where: { ...where, status: 'failed' } }),
      prisma.run.findMany({
        where: { ...where, status: 'failed', storedExecutions: 0 },
        select: { startedAt: true },
      }),
      prisma.run.findFirst({ where, orderBy: { startedAt: 'asc' }, select: { startedAt: true } }),
      prisma.run.findFirst({ where, orderBy: { startedAt: 'desc' }, select: { startedAt: true } }),
      prisma.testExecution.count({ where: { ...where, status: 'flaky' } }),
      prisma.testExecution.count({ where: { ...where, status: 'fail' } }),
      prisma.flakyScore.findMany({
        where,
        orderBy: { score: 'desc' },
        take: 5,
        select: {
          score: true,
          reasonCodes: true,
          identity: { select: { title: true, params: true, fingerprint: true } },
        },
      }),
    ])
  return {
    runs,
    executions,
    tests,
    failedRuns,
    noTestRuns: noTestRows.length,
    noTestNights: new Set(noTestRows.map((row) => row.startedAt.toISOString().slice(0, 10))).size,
    first,
    last,
    flaky,
    failing,
    scores,
  }
}

const testHref = (project, fingerprint) =>
  `${project.slug}/tests/${fingerprint.replace('sha256:', '').slice(0, 16)}.html`

const projectCard = (project, stats) => `
  <div class="card project-card">
    <h3><a href="${project.slug}/flaky.html">${escapeHtml(project.name)}</a></h3>
    <p class="muted" style="margin:0">${escapeHtml(project.summary)}</p>
    <div class="stat-row">
      <div><div class="stat-value">${number(stats.runs)}</div><div class="muted stat-label">${plural(stats.runs, 'run')}</div></div>
      <div><div class="stat-value">${number(stats.executions)}</div><div class="muted stat-label">${plural(stats.executions, 'test execution')}</div></div>
      <div><div class="stat-value">${number(stats.failing)}</div><div class="muted stat-label">${plural(stats.failing, 'failed attempt')}</div></div>
      <div><div class="stat-value">${number(stats.flaky)}</div><div class="muted stat-label">passed on retry</div></div>
    </div>
    <p class="muted" style="font-size:0.8rem;margin:0">
      ${stats.first ? dateRange(stats.first.startedAt, stats.last.startedAt) : ''}
      <a href="https://github.com/${project.repo}">Repository</a>
    </p>
  </div>`

const topTests = (project, stats) => {
  const rows = stats.scores
    .filter((row) => row.score >= 0.1)
    .map((row) => {
      const reasons = row.reasonCodes.map((reason) => reason.code).join(', ')
      const variant = row.identity.params?.variant
      return `<tr>
        <td class="numeric">${row.score.toFixed(2)}</td>
        <td><a href="${testHref(project, row.identity.fingerprint)}">${escapeHtml(row.identity.title)}</a>${variant ? ` <span class="pill">${escapeHtml(variant)}</span>` : ''}</td>
        <td class="muted mono" style="font-size:0.75rem">${escapeHtml(reasons)}</td>
      </tr>`
    })
    .join('')
  return rows
    ? `<table><thead><tr><th class="numeric">Score</th><th>Test</th><th>Why</th></tr></thead><tbody>${rows}</tbody></table>`
    : '<p class="muted">No test scores above 0.10.</p>'
}

const partialOutageOf = async (prisma, project) => {
  const run = await prisma.run.findFirst({
    where: {
      projectId: project.projectId,
      variant: 'live',
      startedAt: {
        gte: PARTIAL_OUTAGE_DAY,
        lt: new Date(PARTIAL_OUTAGE_DAY.getTime() + 86_400_000),
      },
    },
    select: { id: true, passedCount: true, failedCount: true, flakyCount: true },
  })
  if (!run) return null
  const ran = run.passedCount + run.failedCount + run.flakyCount
  const failures = await prisma.testExecution.findMany({
    where: { runId: run.id, status: 'fail' },
    select: { testIdentityId: true, errorMessage: true },
  })
  const shared = findSharedFailures(
    failures.map((failure) => ({
      testId: failure.testIdentityId,
      message: failure.errorMessage,
      recoveredInRun: false,
    })),
    ran,
  )
  return { failed: run.failedCount, ran, shared: shared.size }
}

const outageParagraph = (project, outage) =>
  outage
    ? `<p>
    A partial outage is set aside too. On ${shortDay(PARTIAL_OUTAGE_DAY)} the hosted platform failed
    ${number(outage.failed)} of the ${number(outage.ran)} tests that ran. ${number(outage.shared)} of them
    failed with the same error and passed on that commit on other nights, so those failures do not count
    against them. The other ${number(outage.failed - outage.shared)} failed in their own way and still
    count, so they stay on <a href="${project.slug}/flaky.html">the board</a> with that night as their
    last flake.
  </p>`
    : ''

const mobileMatrix = async (prisma, project) => {
  const identities = await prisma.testIdentity.findMany({
    where: { projectId: project.projectId },
    select: { id: true, title: true, params: true },
  })
  const runs = await prisma.run.findMany({
    where: { projectId: project.projectId },
    select: {
      id: true,
      variant: true,
      status: true,
      storedExecutions: true,
      passedCount: true,
      failedCount: true,
      flakyCount: true,
    },
  })
  const massFailures = runs.filter((run) =>
    isMassFailureRun({
      failed: run.failedCount,
      executed: run.passedCount + run.failedCount + run.flakyCount,
    }),
  )
  const counts = await prisma.testExecution.groupBy({
    by: ['testIdentityId', 'status'],
    where: {
      projectId: project.projectId,
      runId: { notIn: massFailures.map((run) => run.id) },
    },
    _count: { _all: true },
  })
  const byIdentity = new Map()
  for (const row of counts) {
    const entry = byIdentity.get(row.testIdentityId) ?? { fail: 0, flaky: 0, total: 0 }
    if (row.status === 'fail') entry.fail += row._count._all
    if (row.status === 'flaky') entry.flaky += row._count._all
    if (row.status !== 'skip') entry.total += row._count._all
    byIdentity.set(row.testIdentityId, entry)
  }

  const rows = new Map()
  const totals = Object.fromEntries(
    MOBILE_RUNNERS.map((runner) => [runner, { fail: 0, flaky: 0, total: 0, cases: new Set() }]),
  )
  for (const identity of identities) {
    const caseId = testCaseIdOf(identity.title)
    const runner = identity.params?.variant
    if (!caseId || !totals[runner]) continue
    const entry = byIdentity.get(identity.id) ?? { fail: 0, flaky: 0, total: 0 }
    const row = rows.get(caseId) ?? {}
    const cell = row[runner] ?? { fail: 0, flaky: 0, total: 0 }
    cell.fail += entry.fail
    cell.flaky += entry.flaky
    cell.total += entry.total
    row[runner] = cell
    rows.set(caseId, row)
    totals[runner].fail += entry.fail
    totals[runner].flaky += entry.flaky
    totals[runner].total += entry.total
    totals[runner].cases.add(caseId)
  }

  const runsOf = (runner) => runs.filter((run) => run.variant === runner)
  const redRuns = (runner) => runsOf(runner).filter((run) => run.status === 'failed').length
  const noTestRuns = (runner) =>
    runsOf(runner).filter((run) => run.status === 'failed' && run.storedExecutions === 0).length
  const massRuns = (runner) => massFailures.filter((run) => run.variant === runner).length
  const rescuedRuns = (runner) =>
    runsOf(runner).filter((run) => run.status === 'passed' && run.flakyCount > 0).length
  const canceledRuns = (runner) => runsOf(runner).filter((run) => run.status === 'canceled').length

  const noisy = [...rows.entries()]
    .map(([caseId, row]) => ({
      caseId,
      row,
      problems: MOBILE_RUNNERS.reduce(
        (sum, runner) => sum + (row[runner]?.fail ?? 0) + (row[runner]?.flaky ?? 0),
        0,
      ),
    }))
    .filter((entry) => entry.problems > 0)
    .sort((a, b) => b.problems - a.problems || a.caseId.localeCompare(b.caseId))
    .slice(0, 25)

  const cellHtml = (cell) => {
    if (!cell || cell.total === 0) return '<td class="numeric muted">–</td>'
    const parts = []
    if (cell.fail) parts.push(`${cell.fail} failed`)
    if (cell.flaky) parts.push(`${cell.flaky} retried`)
    if (parts.length === 0) return `<td class="numeric muted">${cell.total} clean</td>`
    return `<td class="numeric ${cell.fail ? 'bad' : 'warn'}">${parts.join(', ')}</td>`
  }

  const head = MOBILE_RUNNERS.map((runner) => `<th class="numeric">${runner}</th>`).join('')
  const summary = [
    ['Runs', (runner) => runsOf(runner).length],
    ['Went red', redRuns],
    ['of which no test ran', noTestRuns],
    ['of which most of the suite failed', massRuns],
    ['Cancelled before it finished', canceledRuns],
    ['Green only because a retry rescued it', rescuedRuns],
    ['Test cases seen', (runner) => totals[runner].cases.size],
    ['Failed attempts in the other runs', (runner) => totals[runner].fail],
    ['Tests that passed on retry', (runner) => totals[runner].flaky],
  ]
    .map(
      ([label, value]) =>
        `<tr><td>${label}</td>${MOBILE_RUNNERS.map((runner) => `<td class="numeric">${number(value(runner))}</td>`).join('')}</tr>`,
    )
    .join('')
  const body = noisy
    .map(
      ({ caseId, row }) =>
        `<tr><td class="mono">${caseId}</td>${MOBILE_RUNNERS.map((runner) => cellHtml(row[runner])).join('')}</tr>`,
    )
    .join('')

  const xcuitestRed = redRuns('xcuitest')
  const xcuitestRuns = runsOf('xcuitest').length
  const xcuitestRescued = rescuedRuns('xcuitest')

  return `
    <p>
      The job status alone is misleading. XCUITest went red on ${number(xcuitestRed)} of
      ${number(xcuitestRuns)} runs and looks like the most reliable of the four, yet on
      ${number(xcuitestRescued)} of the runs it reported green a test had failed and only a retry
      saved it. Nobody would have seen those without per-attempt history.
    </p>
    <div class="card"><table><thead><tr><th></th>${head}</tr></thead><tbody>${summary}</tbody></table></div>
    <p class="muted">
      Red and green are the job's own conclusion in CI, so a job can go red with every recorded test
      passing, for example when it could not start a session for the rest. A cancelled job was
      stopped before it finished, so it is neither: the tests it got through are kept, and it does
      not count as red.
    </p>
    <p class="muted">
      The test cases with the most trouble. Runs where most of the suite failed together are left
      out, because they say nothing about one test. A red cell is a failed attempt, and "retried"
      means the same test then passed.
    </p>
    <div class="card"><table><thead><tr><th>Test case</th>${head}</tr></thead><tbody>${body}</tbody></table></div>`
}

export const renderOverview = async (prisma, projects) => {
  const stats = new Map()
  for (const project of projects) stats.set(project.slug, await statsOf(prisma, project))
  const of = (slug) => projects.find((project) => project.slug === slug)
  const playwright = of('playwright')
  const restful = of('restful-booker')
  const mobile = of('mobile')
  const self = of('flakemetry')
  const restfulStats = stats.get('restful-booker')
  const generated = new Date().toISOString().slice(0, 16).replace('T', ' ')

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Flakemetry on real test suites</title>
  <meta name="description" content="Flakemetry running on the real CI history of public test suites, its own included.">
  <meta property="og:title" content="Flakemetry on real test suites">
  <meta property="og:description" content="Flakemetry running on the real CI history of public test suites, its own included.">
  <meta property="og:image" content="https://akogut.github.io/flakemetry/social-preview.png">
  <meta name="twitter:card" content="summary_large_image">
  <link rel="stylesheet" href="assets/style.css">
  <link rel="icon" type="image/svg+xml" href="assets/icon.svg">
</head>
<body>
<div class="overview">
  <div class="brand">flake<span>metry</span></div>
  <h1 class="page-title" style="margin-top:1.5rem">Real test suites, real history</h1>
  <p class="page-subtitle">
    Everything here comes from the CI of public repositories and is rebuilt every night.
    Nothing is seeded. Each test execution went through the same API, worker and scoring as any
    other Flakemetry instance. Last built ${generated} UTC.
  </p>

  <div class="project-grid">
    ${projects.map((project) => projectCard(project, stats.get(project.slug))).join('')}
  </div>

  <h2>A healthy suite says so</h2>
  <p>
    <a href="${playwright.slug}/flaky.html">${escapeHtml(playwright.name)}</a> runs on three
    browsers, and each browser is scored on its own, so a failure on WebKit alone reads as a
    failure there and not as a flake everywhere. Open a test from
    <a href="${playwright.slug}/suite-health.html">suite health</a>, then a trace to see its steps.
  </p>
  <div class="card">${topTests(playwright, stats.get('playwright'))}</div>

  <h2>A run that never started is not a flake</h2>
  <p>
    <a href="${restful.slug}/runs.html">${escapeHtml(restful.name)}</a> tests a hosted demo it does
    not run. In late October that demo
    <a href="https://github.com/${restful.repo}/issues/162">started answering 500 on every per-id route</a>,
    and the suite's readiness gate stopped the run before any test started. Those runs appear as
    <em>no tests ran</em> rather than as gaps, and no test is marked down for them:
    ${number(restfulStats.noTestRuns)} ${plural(restfulStats.noTestRuns, 'run')} on
    ${number(restfulStats.noTestNights)} ${plural(restfulStats.noTestNights, 'night')} so far.
  </p>
  ${outageParagraph(restful, await partialOutageOf(prisma, restful))}
  <p>
    The top of that board is below. The <code>live</code> and <code>local</code> variants are scored
    apart, because a local copy says nothing about the hosted one.
  </p>
  <div class="card">${topTests(restful, restfulStats)}</div>

  <h2 id="one-app-four-runners">One app, four runners</h2>
  <p>
    <a href="${mobile.slug}/flaky.html">${escapeHtml(mobile.name)}</a> runs the same catalogue of
    test cases through Appium on Android and iOS, XCUITest and Espresso. The same app and the same
    cases make the runners directly comparable. Retry settings differ, with up to three iterations
    on XCUITest, so read the failed attempts alongside the retries.
  </p>
  ${await mobileMatrix(prisma, mobile)}

  <h2>The top of the board</h2>
  <div class="card">${topTests(mobile, stats.get('mobile'))}</div>

  <h2>Its own tests too</h2>
  <p>
    <a href="${self.slug}/flaky.html">${escapeHtml(self.name)}</a> runs its whole suite every day
    against a real database and goes on the same board, under the same rules.
  </p>
  <div class="card">${topTests(self, stats.get('flakemetry'))}</div>

  <h2>What you are looking at</h2>
  <ul>
    <li>This is a static snapshot, so it has no search or controls and the trace view does not expand. A running instance has them.</li>
    <li>Recent runs are the artifacts those suites uploaded. Older runs were reconstructed from their CI logs, where durations and error text can be missing.</li>
    <li>On a reconstructed green night, the pass of each test is inferred. The <code>live</code> runs of ${escapeHtml(restful.name)} and the Espresso runs of ${escapeHtml(mobile.name)} log how many tests passed and name only the failures, so the other tests are taken as passed. Failures, skips and the XCUITest and Appium attempts are named in the logs.</li>
    <li>Only the <code>main</code> branch is included.</li>
    <li>AI root-cause analysis needs a model key, so it is not part of this snapshot.</li>
  </ul>
  <p>
    <a href="https://akogut.github.io/flakemetry/guide/integrate.html">Run it on your own suite</a> ·
    <a href="https://github.com/AKogut/flakemetry/tree/main/examples/public-demo">How this page is built</a> ·
    <a href="https://github.com/AKogut/flakemetry">Flakemetry on GitHub</a>
  </p>
</div>
</body>
</html>
`
}
