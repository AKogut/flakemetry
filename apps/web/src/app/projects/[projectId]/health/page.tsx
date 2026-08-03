import { getPrismaClient } from '@flakemetry/db'
import { getTeamHealthLeaderboard, getTestHealthMetrics } from '@flakemetry/queries'

import { MiniTrend } from '@/components/mini-trend'
import { requireUser } from '@/lib/session'
import { requireProjectAccess } from '@/lib/tenant'

const prisma = getPrismaClient()

const WINDOWS = [30, 60, 90]

const HOUR_MS = 60 * 60 * 1000
const DAY_MS = 24 * HOUR_MS

const duration = (ms: number | null): string => {
  if (ms === null) return '—'
  if (ms >= DAY_MS) return `${(ms / DAY_MS).toFixed(1)}d`
  if (ms >= HOUR_MS) return `${(ms / HOUR_MS).toFixed(1)}h`
  return `${Math.max(1, Math.round(ms / 60000))}m`
}

const weekLabel = (date: Date): string =>
  date.toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' })

export default async function TestHealthPage({
  params,
  searchParams,
}: {
  params: Promise<{ projectId: string }>
  searchParams: Promise<{ days?: string; owner?: string }>
}) {
  const { projectId } = await params
  const { days: daysParam, owner: ownerParam } = await searchParams
  const user = await requireUser()
  await requireProjectAccess(user.id, projectId)

  const days = WINDOWS.includes(Number(daysParam)) ? Number(daysParam) : 90

  const teams = await getTeamHealthLeaderboard(prisma, projectId, days)
  const owner = ownerParam && teams.some((team) => team.owner === ownerParam) ? ownerParam : null
  const metrics = await getTestHealthMetrics(prisma, projectId, days, owner)
  const scopeQuery = owner ? `&owner=${encodeURIComponent(owner)}` : ''

  const totalIntroduced = metrics.weekly.reduce((sum, week) => sum + week.introduced, 0)
  const totalResolved = metrics.weekly.reduce((sum, week) => sum + week.resolved, 0)
  const net = totalIntroduced - totalResolved
  const hasHistory =
    totalIntroduced > 0 ||
    totalResolved > 0 ||
    metrics.quarantine.currentBacklog > 0 ||
    metrics.reliabilityTrend.length > 0

  return (
    <>
      <div className="row-between">
        <div>
          <h1 className="page-title" style={{ marginBottom: 0 }}>
            Test health
          </h1>
          <p className="page-subtitle" style={{ marginBottom: 0 }}>
            Is flakiness improving or degrading? Flaky MTTR and introduced-vs-resolved over the last{' '}
            {days} days
            {owner ? (
              <>
                {' '}
                for <span className="mono">{owner}</span>
              </>
            ) : null}
            .
          </p>
        </div>
        <div className="filters">
          {WINDOWS.map((window) => (
            <a
              key={window}
              href={`?days=${window}${scopeQuery}`}
              className="filter-tab"
              data-active={window === days}
            >
              {window}d
            </a>
          ))}
        </div>
      </div>

      {teams.length > 0 ? (
        <div className="filters" style={{ marginBottom: '1rem' }}>
          <a href={`?days=${days}`} className="filter-tab" data-active={owner === null}>
            All teams
          </a>
          {teams.map((team) => (
            <a
              key={team.owner}
              href={`?days=${days}&owner=${encodeURIComponent(team.owner)}`}
              className="filter-tab"
              data-active={team.owner === owner}
            >
              {team.owner}
            </a>
          ))}
        </div>
      ) : null}

      {!hasHistory ? (
        <div className="card">
          <div className="empty">
            Not enough history yet. Health metrics appear once tests start flaking and stabilizing.
          </div>
        </div>
      ) : (
        <>
          <div className="kpi-grid">
            <div className="card kpi">
              <div className="rca-label">Median flaky MTTR</div>
              <div className="kpi-value">{duration(metrics.mttr.medianMs)}</div>
            </div>
            <div className="card kpi">
              <div className="rca-label">Mean flaky MTTR</div>
              <div className="kpi-value">{duration(metrics.mttr.meanMs)}</div>
            </div>
            <div className="card kpi">
              <div className="rca-label">Resolved in range</div>
              <div className="kpi-value" style={{ color: 'var(--pass)' }}>
                {metrics.mttr.resolvedCount}
              </div>
            </div>
            <div className="card kpi">
              <div className="rca-label">Currently flaky</div>
              <div className="kpi-value" style={{ color: 'var(--flaky)' }}>
                {metrics.mttr.openCount}
              </div>
            </div>
            <div className="card kpi">
              <div className="rca-label">Quarantine backlog</div>
              <div className="kpi-value">{metrics.quarantine.currentBacklog}</div>
            </div>
          </div>

          <div className="card">
            <div className="row-between" style={{ marginBottom: '0.6rem' }}>
              <div className="rca-label">Flaky introduced vs resolved, per week</div>
              <div className="mono muted" style={{ fontSize: '0.78rem' }}>
                {totalIntroduced} introduced · {totalResolved} resolved ·{' '}
                <span style={{ color: net > 0 ? 'var(--fail)' : 'var(--pass)' }}>
                  net {net > 0 ? '+' : ''}
                  {net}
                </span>
              </div>
            </div>
            <div className="trend-grid">
              <div>
                <div className="rca-label" style={{ marginBottom: '0.5rem' }}>
                  Introduced
                </div>
                <MiniTrend
                  values={metrics.weekly.map((week) => week.introduced)}
                  tone="var(--flaky)"
                  label="flaky tests introduced per week"
                />
              </div>
              <div>
                <div className="rca-label" style={{ marginBottom: '0.5rem' }}>
                  Resolved
                </div>
                <MiniTrend
                  values={metrics.weekly.map((week) => week.resolved)}
                  tone="var(--pass)"
                  label="flaky tests resolved per week"
                />
              </div>
            </div>
          </div>

          <div className="trend-grid">
            <div className="card">
              <div className="rca-label" style={{ marginBottom: '0.5rem' }}>
                Pass rate over time
              </div>
              <MiniTrend
                values={metrics.reliabilityTrend.map((point) => point.passRate)}
                max={1}
                tone="var(--pass)"
                label="pass rate per day"
              />
            </div>
            <div className="card">
              <div className="rca-label" style={{ marginBottom: '0.5rem' }}>
                Quarantine backlog over time
              </div>
              <MiniTrend
                values={metrics.quarantine.trend.map((point) => point.count)}
                tone="var(--flaky)"
                label="quarantined test count per day"
              />
            </div>
          </div>

          {owner === null && teams.length > 0 ? (
            <div className="card">
              <div className="rca-label" style={{ marginBottom: '0.6rem' }}>
                Flaky backlog by team
              </div>
              <p className="muted" style={{ fontSize: '0.8rem', marginBottom: '0.6rem' }}>
                Owners come from CODEOWNERS. A positive net means that team introduced more flaky
                tests than it fixed in this window.
              </p>
              <table>
                <thead>
                  <tr>
                    <th>Team</th>
                    <th style={{ textAlign: 'right' }}>Currently flaky</th>
                    <th style={{ textAlign: 'right' }}>Quarantined</th>
                    <th style={{ textAlign: 'right' }}>Introduced</th>
                    <th style={{ textAlign: 'right' }}>Resolved</th>
                    <th style={{ textAlign: 'right' }}>Net</th>
                  </tr>
                </thead>
                <tbody>
                  {teams.map((team) => (
                    <tr key={team.owner}>
                      <td className="mono">
                        <a href={`?days=${days}&owner=${encodeURIComponent(team.owner)}`}>
                          {team.owner}
                        </a>
                      </td>
                      <td style={{ textAlign: 'right', color: 'var(--flaky)' }}>
                        {team.currentlyFlaky}
                      </td>
                      <td style={{ textAlign: 'right' }} className="muted">
                        {team.quarantined}
                      </td>
                      <td style={{ textAlign: 'right' }}>{team.introduced}</td>
                      <td style={{ textAlign: 'right', color: 'var(--pass)' }}>{team.resolved}</td>
                      <td
                        style={{
                          textAlign: 'right',
                          fontWeight: 600,
                          color: team.net > 0 ? 'var(--fail)' : undefined,
                        }}
                      >
                        {team.net > 0 ? '+' : ''}
                        {team.net}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : null}

          {metrics.weekly.length > 0 ? (
            <div className="card">
              <div className="rca-label" style={{ marginBottom: '0.6rem' }}>
                Weekly breakdown
              </div>
              <table>
                <thead>
                  <tr>
                    <th>Week of</th>
                    <th style={{ textAlign: 'right' }}>Introduced</th>
                    <th style={{ textAlign: 'right' }}>Resolved</th>
                    <th style={{ textAlign: 'right' }}>Net</th>
                  </tr>
                </thead>
                <tbody>
                  {metrics.weekly.map((week) => {
                    const weekNet = week.introduced - week.resolved
                    return (
                      <tr key={week.weekStart.toISOString()}>
                        <td className="mono">{weekLabel(week.weekStart)}</td>
                        <td style={{ textAlign: 'right', color: 'var(--flaky)' }}>
                          {week.introduced}
                        </td>
                        <td style={{ textAlign: 'right', color: 'var(--pass)' }}>
                          {week.resolved}
                        </td>
                        <td
                          style={{
                            textAlign: 'right',
                            fontWeight: 600,
                            color: weekNet > 0 ? 'var(--fail)' : undefined,
                          }}
                        >
                          {weekNet > 0 ? '+' : ''}
                          {weekNet}
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
          ) : null}
        </>
      )}
    </>
  )
}
