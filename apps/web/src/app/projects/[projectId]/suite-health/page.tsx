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
import { requireUser } from '@/lib/session'
import { requireProjectAccess } from '@/lib/tenant'

const prisma = getPrismaClient()

const WINDOWS = [7, 14, 30]

const percent = (value: number): string => `${Math.round(value * 100)}%`
const seconds = (ms: number): string => `${(ms / 1000).toFixed(1)}s`

export default async function SuiteHealthPage({
  params,
  searchParams,
}: {
  params: Promise<{ projectId: string }>
  searchParams: Promise<{ days?: string }>
}) {
  const { projectId } = await params
  const { days: daysParam } = await searchParams
  const user = await requireUser()
  await requireProjectAccess(user.id, projectId)

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
                {percent(kpis.passRate)}
              </div>
            </div>
            <div className="card kpi">
              <div className="rca-label">Flaky rate</div>
              <div className="kpi-value" style={{ color: 'var(--flaky)' }}>
                {percent(kpis.flakyRate)}
              </div>
            </div>
            <div className="card kpi">
              <div className="rca-label">Avg test duration</div>
              <div className="kpi-value">{seconds(kpis.avgDurationMs)}</div>
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
                Flaky tests over time
              </div>
              <MiniTrend
                values={flakyTrend.map((point) => point.flakyCount)}
                tone="var(--flaky)"
                label="flaky test count per day"
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
                          <div className="mono muted" style={{ fontSize: '0.72rem' }}>
                            {test.suite}
                          </div>
                        </td>
                        <td style={{ textAlign: 'right', fontWeight: 600 }}>
                          {seconds(test.avgDurationMs)}
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
              {leaderboards.mostFailing.length === 0 ? (
                <div className="empty">No failures in this window.</div>
              ) : (
                <table>
                  <tbody>
                    {leaderboards.mostFailing.map((test) => (
                      <tr key={test.testIdentityId}>
                        <td>
                          <a href={testHref(test.testIdentityId)}>{test.title}</a>
                          <div className="mono muted" style={{ fontSize: '0.72rem' }}>
                            {test.suite}
                          </div>
                        </td>
                        <td style={{ textAlign: 'right', fontWeight: 600, color: 'var(--fail)' }}>
                          {percent(test.failRate)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>
          </div>

          <div className="card">
            <div className="rca-label" style={{ marginBottom: '0.6rem' }}>
              Suites
            </div>
            {suites.length === 0 ? (
              <div className="empty">No suite data yet.</div>
            ) : (
              <table>
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
                      <td className="mono">
                        {suite.suite || '(root)'}
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
                        style={{
                          textAlign: 'right',
                          color: suite.failRate > 0 ? 'var(--fail)' : undefined,
                        }}
                      >
                        {percent(suite.failRate)}
                      </td>
                      <td style={{ textAlign: 'right' }}>{seconds(suite.avgDurationMs)}</td>
                      <td style={{ textAlign: 'right' }} className="muted">
                        {suite.total}
                      </td>
                      <td>
                        <MiniTrend
                          values={suite.days.map((point) =>
                            point.total > 0 ? (point.failed + point.flaky) / point.total : 0,
                          )}
                          max={1}
                          tone="var(--fail)"
                          label={`${suite.suite} fail rate trend`}
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
