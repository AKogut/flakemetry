import { getPrismaClient } from '@flakemetry/db'
import {
  getDailyTrend,
  getFlakyTrend,
  getProjectHealthKpis,
  getSuiteHealth,
  getTestLeaderboards,
  isSuiteDurationRegressed,
  isSuiteRegressed,
} from '@flakemetry/queries'

import { MiniTrend } from '@/components/mini-trend'
import { formatPercent, formatTestDuration, suiteName, testLocation } from '@/lib/format'
import { requireProjectViewer } from '@/lib/viewer'

const prisma = getPrismaClient()

const WINDOWS = [7, 14, 30]

export default async function SuiteHealthPage({
  params,
  searchParams,
}: {
  params: Promise<{ projectId: string }>
  searchParams: Promise<{ days?: string }>
}) {
  const { projectId } = await params
  const { days: daysParam } = await searchParams
  await requireProjectViewer(projectId)

  const days = WINDOWS.includes(Number(daysParam)) ? Number(daysParam) : 14

  const [kpis, daily, leaderboards, suites, flakyTrend] = await Promise.all([
    getProjectHealthKpis(prisma, projectId, days),
    getDailyTrend(prisma, projectId, days),
    getTestLeaderboards(prisma, projectId, days),
    getSuiteHealth(prisma, projectId, days),
    getFlakyTrend(prisma, projectId, days),
  ])

  const base = `/projects/${projectId}`
  const testHref = (id: string) => `${base}/tests/${id}`

  return (
    <>
      <div className="row-between">
        <div>
          <h1 className="page-title" style={{ marginBottom: 0 }}>
            Suite health
          </h1>
          <p className="page-subtitle" style={{ marginBottom: 0 }}>
            Is the suite getting slower or flakier? Last {days} days.
          </p>
        </div>
        <div className="filters">
          {WINDOWS.map((window) => (
            <a
              key={window}
              href={`?days=${window}`}
              className="filter-tab"
              data-active={window === days}
            >
              {window}d
            </a>
          ))}
        </div>
      </div>

      {kpis.totalExecutions === 0 ? (
        <div className="card">
          <div className="empty">No runs in this window yet.</div>
        </div>
      ) : (
        <>
          <div className="kpi-grid">
            <div className="card kpi">
              <div className="rca-label">Pass rate</div>
              <div className="kpi-value" style={{ color: 'var(--pass)' }}>
                {formatPercent(kpis.passRate)}
              </div>
              {kpis.skipped > 0 ? (
                <div className="muted" style={{ fontSize: '0.8rem' }}>
                  {kpis.skipped.toLocaleString()} skipped, not counted
                </div>
              ) : null}
            </div>
            <div className="card kpi">
              <div className="rca-label">Flaky rate</div>
              <div className="kpi-value" style={{ color: 'var(--flaky)' }}>
                {formatPercent(kpis.flakyRate)}
              </div>
            </div>
            <div className="card kpi">
              <div className="rca-label">Avg test duration</div>
              <div className="kpi-value">{formatTestDuration(kpis.avgDurationMs)}</div>
            </div>
            <div className="card kpi">
              <div className="rca-label">Executions</div>
              <div className="kpi-value">{kpis.totalExecutions.toLocaleString()}</div>
            </div>
          </div>

          <div className="trend-grid">
            <div className="card">
              <div className="rca-label" style={{ marginBottom: '0.5rem' }}>
                Pass rate over time
              </div>
              <MiniTrend
                values={daily.map((point) => point.passRate)}
                max={1}
                tone="var(--pass)"
                label="pass rate per day"
              />
            </div>
            <div className="card">
              <div className="rca-label" style={{ marginBottom: '0.5rem' }}>
                Avg duration over time
              </div>
              <MiniTrend
                values={daily.map((point) => point.avgDurationMs)}
                label="avg duration per day"
              />
            </div>
            <div className="card">
              <div className="rca-label" style={{ marginBottom: '0.5rem' }}>
                Tests above the quarantine bar over time
              </div>
              <MiniTrend
                values={flakyTrend.map((point) => point.flakyCount)}
                tone="var(--flaky)"
                label="tests above the quarantine bar per day"
                flatMessage="No test was above the quarantine bar in this window."
              />
            </div>
          </div>

          <div className="board-grid">
            <div className="card">
              <div className="rca-label" style={{ marginBottom: '0.6rem' }}>
                Slowest tests
              </div>
              {leaderboards.slowest.length === 0 ? (
                <div className="empty">No data.</div>
              ) : (
                <table>
                  <tbody>
                    {leaderboards.slowest.map((test) => (
                      <tr key={test.testIdentityId}>
                        <td>
                          <a href={testHref(test.testIdentityId)}>{test.title}</a>
                          {test.variant ? (
                            <span className="pill" style={{ marginLeft: '0.4rem' }}>
                              {test.variant}
                            </span>
                          ) : null}
                          <div className="mono muted" style={{ fontSize: '0.72rem' }}>
                            {testLocation(test.suite, test.filePath)}
                          </div>
                        </td>
                        <td style={{ textAlign: 'right', fontWeight: 600 }}>
                          {formatTestDuration(test.avgDurationMs)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>

            <div className="card">
              <div className="rca-label" style={{ marginBottom: '0.6rem' }}>
                Most failing tests
              </div>
              <p className="muted" style={{ fontSize: '0.8rem', margin: '-0.3rem 0 0.6rem' }}>
                Runs that failed on the first attempt.
              </p>
              {leaderboards.mostFailing.length === 0 ? (
                <div className="empty">No test failed a first attempt in this window.</div>
              ) : (
                <table>
                  <tbody>
                    {leaderboards.mostFailing.map((test) => (
                      <tr key={test.testIdentityId}>
                        <td>
                          <a href={testHref(test.testIdentityId)}>{test.title}</a>
                          {test.variant ? (
                            <span className="pill" style={{ marginLeft: '0.4rem' }}>
                              {test.variant}
                            </span>
                          ) : null}
                          <div className="mono muted" style={{ fontSize: '0.72rem' }}>
                            {testLocation(test.suite, test.filePath)}
                          </div>
                        </td>
                        <td style={{ textAlign: 'right', fontWeight: 600, color: 'var(--fail)' }}>
                          {formatPercent(test.failRate)}
                          <div className="muted" style={{ fontSize: '0.72rem', fontWeight: 400 }}>
                            {test.failedRuns} of {test.runs}
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
              {leaderboards.failingHooks > 0 ? (
                <p className="muted" style={{ fontSize: '0.8rem', margin: '0.6rem 0 0' }}>
                  {leaderboards.failingHooks} failing{' '}
                  {leaderboards.failingHooks === 1 ? 'hook' : 'hooks'} not listed: a hook is only
                  reported when it fails, so it has no rate.
                </p>
              ) : null}
            </div>
          </div>

          <div className="card">
            <div className="rca-label" style={{ marginBottom: '0.6rem' }}>
              Suites
            </div>
            {suites.length === 0 ? (
              <div className="empty">No suite data yet.</div>
            ) : (
              <table className="table-stack">
                <thead>
                  <tr>
                    <th>Suite</th>
                    <th style={{ textAlign: 'right' }}>Fail rate</th>
                    <th style={{ textAlign: 'right' }}>Avg duration</th>
                    <th style={{ textAlign: 'right' }}>Executions</th>
                    <th style={{ width: '140px' }}>Trend</th>
                  </tr>
                </thead>
                <tbody>
                  {suites.map((suite) => (
                    <tr key={suite.suite}>
                      <td className="mono stack-main">
                        {suiteName(suite.suite)}
                        {isSuiteRegressed(suite.days) ? (
                          <span className="pill pill-candidate" style={{ marginLeft: '0.5rem' }}>
                            regressed
                          </span>
                        ) : null}
                        {isSuiteDurationRegressed(suite.days) ? (
                          <span className="pill pill-candidate" style={{ marginLeft: '0.5rem' }}>
                            slower
                          </span>
                        ) : null}
                      </td>
                      <td
                        data-label="Fail rate"
                        style={{
                          textAlign: 'right',
                          color: suite.failRate > 0 ? 'var(--fail)' : undefined,
                        }}
                      >
                        {suite.ran === 0 ? '—' : formatPercent(suite.failRate)}
                      </td>
                      <td data-label="Avg duration" style={{ textAlign: 'right' }}>
                        {formatTestDuration(suite.avgDurationMs)}
                      </td>
                      <td data-label="Executions" style={{ textAlign: 'right' }} className="muted">
                        {suite.total}
                      </td>
                      <td className="stack-main">
                        <MiniTrend
                          values={suite.days.map((point) =>
                            point.ran > 0 ? (point.failed + point.flaky) / point.ran : null,
                          )}
                          max={1}
                          tone="var(--fail)"
                          label={`${suiteName(suite.suite)} fail rate trend`}
                        />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </>
      )}
    </>
  )
}
