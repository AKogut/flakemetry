import { getPrismaClient } from '@flakemetry/db'
import { getEffectiveProjectPolicy, getFlakinessCost } from '@flakemetry/queries'

import { MiniTrend } from '@/components/mini-trend'
import { requireUser } from '@/lib/session'
import { requireProjectAccess } from '@/lib/tenant'

const prisma = getPrismaClient()

const WINDOWS = [7, 14, 30]

const money = (value: number): string =>
  new Intl.NumberFormat('en', {
    style: 'currency',
    currency: 'USD',
    maximumFractionDigits: 0,
  }).format(value)

const preciseMoney = (value: number): string =>
  new Intl.NumberFormat('en', { style: 'currency', currency: 'USD' }).format(value)

const hours = (ms: number): string => {
  const minutes = ms / 60_000
  if (minutes < 60) return `${minutes.toFixed(0)} min`
  return `${(minutes / 60).toFixed(1)} h`
}

const day = (date: Date): string =>
  new Intl.DateTimeFormat('en', { month: 'short', day: 'numeric' }).format(date)

export default async function CostPage({
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

  const days = WINDOWS.includes(Number(daysParam)) ? Number(daysParam) : 30

  const { effective } = await getEffectiveProjectPolicy(prisma, projectId)
  const rates = {
    ciMinuteCost: effective.ciMinuteCost.value,
    developerHourCost: effective.developerHourCost.value,
    investigationMinutes: effective.investigationMinutes.value,
  }
  const cost = await getFlakinessCost(prisma, projectId, days, rates)

  const base = `/projects/${projectId}`
  const hasData = cost.totals.rerunCount > 0 || cost.totals.flakyOccurrences > 0

  return (
    <>
      <div className="row-between">
        <div>
          <h1 className="page-title">Cost of flakiness</h1>
          <p className="page-subtitle">
            What re-running unreliable tests spent over the last {days} days.
          </p>
        </div>
        <div className="pager">
          {WINDOWS.map((window) => (
            <a
              key={window}
              className={`btn ${window === days ? 'btn-primary' : 'btn-secondary'}`}
              href={`${base}/cost?days=${window}`}
            >
              {window}d
            </a>
          ))}
        </div>
      </div>

      {!hasData ? (
        <div className="card empty">
          <p>Nothing to attribute yet.</p>
          <p style={{ fontSize: '0.85rem' }}>
            This page fills in once a test is retried. If your runner is not configured to retry,
            there is no rerun wall-clock to measure and this will stay empty by design.
          </p>
        </div>
      ) : (
        <>
          <div className="kpi-grid">
            <div className="card kpi">
              <div className="muted">Total</div>
              <div className="kpi-value">{money(cost.totals.totalSpend)}</div>
              <div className="muted" style={{ fontSize: '0.8rem' }}>
                over {days} days
              </div>
            </div>
            <div className="card kpi">
              <div className="muted">CI time re-running</div>
              <div className="kpi-value">{hours(cost.totals.rerunMs)}</div>
              <div className="muted" style={{ fontSize: '0.8rem' }}>
                {cost.totals.rerunCount} retries · {preciseMoney(cost.totals.ciSpend)}
              </div>
            </div>
            <div className="card kpi">
              <div className="muted">Interruptions</div>
              <div className="kpi-value">{cost.totals.flakyOccurrences}</div>
              <div className="muted" style={{ fontSize: '0.8rem' }}>
                {preciseMoney(cost.totals.peopleSpend)} of people&apos;s time
              </div>
            </div>
            <div className="card kpi">
              <div className="muted">Avoided by quarantine</div>
              <div className="kpi-value">{money(cost.avoided.peopleSpend)}</div>
              <div className="muted" style={{ fontSize: '0.8rem' }}>
                {cost.avoided.quarantinedTests} test
                {cost.avoided.quarantinedTests === 1 ? '' : 's'} no longer blocking
              </div>
            </div>
          </div>

          <div className="notice-box">
            <strong>How this is worked out.</strong> The retry wall-clock is measured — an attempt
            after the first only exists because an earlier one failed. Everything in money is that
            measurement times rates you set:{' '}
            <span className="mono">{preciseMoney(rates.ciMinuteCost)}</span> per CI minute (
            {effective.ciMinuteCost.source}),{' '}
            <span className="mono">{preciseMoney(rates.developerHourCost)}</span> per developer hour
            ({effective.developerHourCost.source}), and{' '}
            <span className="mono">{rates.investigationMinutes} min</span> assumed per interruption
            ({effective.investigationMinutes.source}).{' '}
            <a href={`${base}/settings/policy`} style={{ color: 'var(--accent)' }}>
              Change them in policy
            </a>
            . Quarantine credits back only the interruption: a quarantined test still runs, so its
            CI minutes are not saved.
          </div>

          {cost.trend.length > 1 ? (
            <div className="card" style={{ marginBottom: '1.25rem' }}>
              <div className="muted">Spend per day</div>
              <MiniTrend
                values={cost.trend.map((entry) => entry.spend)}
                label={`${day(cost.trend[0]!.day)} — ${day(cost.trend[cost.trend.length - 1]!.day)}`}
              />
            </div>
          ) : null}

          <div className="card">
            <h2 style={{ fontSize: '1rem', marginBottom: '0.75rem' }}>Where it went</h2>
            <table>
              <thead>
                <tr>
                  <th>Test</th>
                  <th>Suite</th>
                  <th>Retries</th>
                  <th>CI time</th>
                  <th>Interruptions</th>
                  <th>Cost</th>
                </tr>
              </thead>
              <tbody>
                {cost.offenders.map((offender) => (
                  <tr key={offender.testIdentityId}>
                    <td>
                      <a href={`${base}/tests/${offender.testIdentityId}`}>{offender.title}</a>
                      {offender.quarantined ? <span className="muted"> 🔒</span> : null}
                    </td>
                    <td className="muted">{offender.suite}</td>
                    <td>{offender.rerunCount}</td>
                    <td className="muted">{hours(offender.rerunMs)}</td>
                    <td>{offender.flakyOccurrences}</td>
                    <td>{preciseMoney(offender.spend)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </>
  )
}
