import { matchCodeowners, parseCodeowners } from '@flakemetry/core'
import { getPrismaClient } from '@flakemetry/db'
import { getClusterImpact, getRca, getTest } from '@flakemetry/queries'
import { notFound } from 'next/navigation'

import { RcaPanel } from '@/components/rca-panel'
import { ReasonCodes, ScoreBadge } from '@/components/score'
import { Sparkline } from '@/components/sparkline'
import { requireUser } from '@/lib/session'
import { requireProjectAccess } from '@/lib/tenant'

const prisma = getPrismaClient()

const HISTORY_LIMIT = 60

const statusTone: Record<string, string> = {
  pass: 'var(--pass)',
  fail: 'var(--fail)',
  flaky: 'var(--flaky)',
  skip: 'var(--skip)',
}

const formatWhen = (date: Date): string =>
  new Intl.DateTimeFormat('en', {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(date)

export default async function TestDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ projectId: string; testId: string }>
  searchParams: Promise<{ execution?: string }>
}) {
  const { projectId, testId } = await params
  const { execution: selectedExecutionId } = await searchParams
  const user = await requireUser()
  await requireProjectAccess(user.id, projectId)

  const test = await getTest(prisma, projectId, testId, HISTORY_LIMIT)
  if (!test) notFound()

  const project = await prisma.project.findUnique({
    where: { id: projectId },
    select: { codeowners: true },
  })
  const owners = project?.codeowners
    ? matchCodeowners(parseCodeowners(project.codeowners), test.filePath)
    : []

  const timeline = [...test.history].reverse()
  const failures = timeline.filter((point) => point.status === 'fail')
  const selected =
    failures.find((point) => point.executionId === selectedExecutionId) ?? failures[0] ?? null
  const rcaReport = selected ? await getRca(prisma, projectId, selected.executionId) : null
  const cluster = selected ? await getClusterImpact(prisma, projectId, selected.executionId) : null

  const base = `/projects/${projectId}/tests/${testId}`

  return (
    <>
      <div className="row-between">
        <div>
          <h1 className="page-title">{test.title}</h1>
          <p className="page-subtitle" style={{ marginBottom: 0 }}>
            <span className="mono">{test.suite}</span> ·{' '}
            <span className="mono">{test.filePath}</span>
            {owners.length > 0 ? (
              <>
                {' · '}
                {owners.map((ownerHandle) => (
                  <a
                    key={ownerHandle}
                    href={`/projects/${projectId}/flaky?owner=${encodeURIComponent(ownerHandle)}`}
                    className="mono"
                    style={{ marginRight: '0.4rem' }}
                  >
                    {ownerHandle}
                  </a>
                ))}
              </>
            ) : null}
          </p>
        </div>
        <div style={{ textAlign: 'right' }}>
          <div style={{ fontSize: '1.6rem' }}>
            <ScoreBadge score={test.score} />
          </div>
          {test.quarantined ? <span className="pill pill-quarantined">quarantined</span> : null}
        </div>
      </div>

      <div className="card" style={{ marginBottom: '1.25rem' }}>
        <div className="rca-label">Last {timeline.length} executions</div>
        <Sparkline points={test.history} />
        <div className="muted" style={{ fontSize: '0.78rem', marginTop: '0.4rem' }}>
          oldest → newest
        </div>
      </div>

      <div className="card" style={{ marginBottom: '1.25rem' }}>
        <div className="rca-label" style={{ marginBottom: '0.6rem' }}>
          Why this score
        </div>
        <ReasonCodes codes={test.reasonCodes} />
      </div>

      {selected ? (
        <div style={{ marginBottom: '1.25rem' }}>
          <RcaPanel report={rcaReport} errorMessage={selected.errorMessage} />
        </div>
      ) : null}

      {cluster ? (
        <div className="card" style={{ marginBottom: '1.25rem' }}>
          <div className="row-between" style={{ marginBottom: '0.6rem' }}>
            <strong>Related failures</strong>
            <span className="muted" style={{ fontSize: '0.8rem' }}>
              same error cluster · {cluster.occurrenceCount.toLocaleString()} occurrence
              {cluster.occurrenceCount === 1 ? '' : 's'}
            </span>
          </div>
          <p className="muted" style={{ marginBottom: '0.6rem' }}>
            This failure clusters with {cluster.tests.length} other test
            {cluster.tests.length === 1 ? '' : 's'} — likely one root cause, not{' '}
            {cluster.tests.length === 1 ? 'an isolated' : 'many isolated'} bug
            {cluster.tests.length === 1 ? '' : 's'}.
          </p>
          <ul className="reasons">
            {cluster.tests.map((related) => (
              <li key={related.testIdentityId}>
                <a href={`/projects/${projectId}/tests/${related.testIdentityId}`}>
                  {related.title}
                </a>
                <span className="mono muted" style={{ fontSize: '0.8rem' }}>
                  {' '}
                  · {related.suite} · {related.filePath}
                </span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      <div className="card">
        <div className="rca-label" style={{ marginBottom: '0.6rem' }}>
          Executions
        </div>
        {timeline.length === 0 ? (
          <div className="empty">No executions recorded.</div>
        ) : (
          <table>
            <thead>
              <tr>
                <th>Status</th>
                <th>Attempt</th>
                <th>Commit</th>
                <th>Branch</th>
                <th>Duration</th>
                <th>When</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {timeline.map((point) => (
                <tr
                  key={point.executionId}
                  style={
                    selected?.executionId === point.executionId
                      ? { background: 'var(--surface-2)' }
                      : undefined
                  }
                >
                  <td style={{ color: statusTone[point.status], fontWeight: 600 }}>
                    {point.status}
                  </td>
                  <td className="muted">#{point.attempt}</td>
                  <td className="mono">{point.commitSha.slice(0, 7)}</td>
                  <td className="mono muted">{point.branch}</td>
                  <td className="muted">{point.durationMs}ms</td>
                  <td className="muted">{formatWhen(point.startedAt)}</td>
                  <td style={{ textAlign: 'right' }}>
                    {point.status === 'fail' ? (
                      <a
                        href={`${base}?execution=${point.executionId}`}
                        style={{
                          color: 'var(--accent)',
                          fontSize: '0.85rem',
                          marginRight: '0.9rem',
                        }}
                      >
                        {point.hasRca ? 'View RCA' : 'Inspect'}
                      </a>
                    ) : null}
                    <a
                      href={`${base}/executions/${point.executionId}`}
                      style={{ color: 'var(--accent)', fontSize: '0.85rem' }}
                    >
                      Trace
                    </a>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </>
  )
}
