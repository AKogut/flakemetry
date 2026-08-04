import { getPrismaClient } from '@flakemetry/db'
import { getIngestionHealth, listRuns } from '@flakemetry/queries'

import { requireUser } from '@/lib/session'
import { requireProjectAccess } from '@/lib/tenant'

const prisma = getPrismaClient()

const RUNS_PER_PAGE = 20

const statusDot: Record<string, string> = {
  passed: 'dot-passed',
  failed: 'dot-failed',
  running: 'dot-running',
  canceled: 'dot-canceled',
}

const formatDuration = (ms: number | null): string => {
  if (ms == null) return '—'
  if (ms < 1000) return `${ms}ms`
  const seconds = Math.round(ms / 1000)
  if (seconds < 60) return `${seconds}s`
  return `${Math.floor(seconds / 60)}m ${seconds % 60}s`
}

const formatWhen = (date: Date): string =>
  new Intl.DateTimeFormat('en', {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(date)

export default async function RunsPage({
  params,
  searchParams,
}: {
  params: Promise<{ projectId: string }>
  searchParams: Promise<{ cursor?: string; branch?: string }>
}) {
  const { projectId } = await params
  const { cursor, branch } = await searchParams
  const user = await requireUser()
  await requireProjectAccess(user.id, projectId)

  const [{ items, nextCursor }, ingestion] = await Promise.all([
    listRuns(prisma, projectId, {
      limit: RUNS_PER_PAGE,
      ...(cursor ? { cursor } : {}),
      ...(branch ? { branch } : {}),
    }),
    getIngestionHealth(prisma, projectId),
  ])

  const base = `/projects/${projectId}/runs`
  const branchQuery = branch ? `&branch=${encodeURIComponent(branch)}` : ''

  return (
    <>
      <h1 className="page-title">Runs</h1>

      <p className="page-subtitle">
        {branch ? (
          <>
            Filtered to <span className="mono">{branch}</span> ·{' '}
            <a href={base} style={{ color: 'var(--accent)' }}>
              clear
            </a>
          </>
        ) : (
          'Every CI run ingested for this project, newest first.'
        )}
      </p>

      {ingestion.failed > 0 ? (
        <div className="error-box">
          <strong>
            {ingestion.failed} run{ingestion.failed === 1 ? '' : 's'} could not be processed
          </strong>
          <p style={{ fontSize: '0.85rem', margin: '0.35rem 0 0.5rem' }}>
            These were accepted by the API but failed every retry, so they are missing from the list
            below.
          </p>
          <ul style={{ fontSize: '0.8rem', margin: 0, paddingLeft: '1.1rem' }}>
            {ingestion.recent.map((job) => (
              <li key={job.id}>
                <span className="mono">{job.idempotencyKey}</span> —{' '}
                {job.lastError ?? 'no reason recorded'}{' '}
                <span className="muted">
                  ({job.attempts} attempt{job.attempts === 1 ? '' : 's'},{' '}
                  {formatWhen(job.updatedAt)})
                </span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      <div className="card">
        {items.length === 0 ? (
          <div className="empty">
            <p>No runs yet.</p>
            <p style={{ fontSize: '0.85rem' }}>
              Add the reporter to your Playwright config and set{' '}
              <span className="mono">FLAKEMETRY_TOKEN</span> in CI to start ingesting.
            </p>
          </div>
        ) : (
          <table>
            <thead>
              <tr>
                <th>Status</th>
                <th>Commit</th>
                <th>Branch</th>
                <th>Tests</th>
                <th>Duration</th>
                <th>Started</th>
              </tr>
            </thead>
            <tbody>
              {items.map((run) => (
                <tr key={run.id}>
                  <td>
                    <span className="status">
                      <span className={`dot ${statusDot[run.status] ?? 'dot-canceled'}`} />
                      {run.status}
                    </span>
                  </td>
                  <td className="mono">{run.commitSha.slice(0, 7)}</td>
                  <td>
                    <a href={`${base}?branch=${encodeURIComponent(run.branch)}`} className="mono">
                      {run.branch}
                    </a>
                    {run.prNumber ? <span className="muted"> #{run.prNumber}</span> : null}
                  </td>
                  <td>
                    <span className="counts">
                      <span className="count-pass">{run.counts.passed}</span>
                      <span className="count-fail">{run.counts.failed}</span>
                      <span className="count-flaky">{run.counts.flaky}</span>
                      <span className="count-skip">{run.counts.skipped}</span>
                    </span>
                  </td>
                  <td className="muted">{formatDuration(run.durationMs)}</td>
                  <td className="muted">{formatWhen(run.startedAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {nextCursor ? (
        <div className="pager">
          <a className="btn btn-secondary" href={`${base}?cursor=${nextCursor}${branchQuery}`}>
            Next page
          </a>
        </div>
      ) : null}
    </>
  )
}
