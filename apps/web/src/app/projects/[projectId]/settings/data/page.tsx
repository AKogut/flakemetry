import { getPrismaClient } from '@flakemetry/db'
import {
  formatBytes,
  getEffectiveProjectPolicy,
  getProjectUsage,
  listDataRequests,
} from '@flakemetry/queries'
import { projectArtifactPrefix, resolveObjectStore } from '@flakemetry/storage'

import { requestProjectErasure, requestWorkspaceErasure } from '@/lib/actions'
import { requireUser } from '@/lib/session'
import { requireProjectAccess } from '@/lib/tenant'

const prisma = getPrismaClient()

const formatDate = (date: Date | null): string =>
  date
    ? new Intl.DateTimeFormat('en', {
        month: 'short',
        day: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
      }).format(date)
    : '—'

const retentionLabel = (days: number | null | undefined, fallback: string | undefined): string => {
  if (typeof days === 'number' && days > 0) return `${days} days`
  const global = Number(fallback)
  return Number.isFinite(global) && global > 0 ? `${global} days (server default)` : 'kept forever'
}

export default async function DataPage({
  params,
  searchParams,
}: {
  params: Promise<{ projectId: string }>
  searchParams: Promise<{ requested?: string }>
}) {
  const { projectId } = await params
  const { requested } = await searchParams
  const user = await requireUser()
  const project = await requireProjectAccess(user.id, projectId)

  const effective = await getEffectiveProjectPolicy(prisma, projectId)
  const store = resolveObjectStore(process.env)
  const usage = await getProjectUsage(
    prisma,
    projectId,
    effective.effective.aiDailyTokenBudget.value,
    {
      artifacts: store ? { prefix: projectArtifactPrefix(project.orgId, project.id), store } : null,
    },
  )

  const [policy, requests] = await Promise.all([
    prisma.projectPolicy.findUnique({
      where: { projectId },
      select: { executionRetentionDays: true, artifactRetentionDays: true },
    }),
    listDataRequests(prisma, { projectId }),
  ])

  const isOwner = project.role === 'owner'
  const pendingErasure = requests.some(
    (request) =>
      request.kind === 'erasure' && (request.status === 'pending' || request.status === 'running'),
  )

  return (
    <>
      <h1 className="page-title">Data</h1>
      <p className="page-subtitle">
        Export everything this project holds, see how long it is kept, and delete it for good.
      </p>

      {requested === 'project' ? (
        <div className="card" style={{ marginBottom: '1.25rem', borderColor: 'var(--accent)' }}>
          <strong>Deletion requested.</strong> The ingest tokens for this project are revoked
          already, so nothing new can arrive. The worker erases the rest within a minute and records
          the result below.
        </div>
      ) : null}

      <div className="card" style={{ marginBottom: '1.25rem' }}>
        <h2 style={{ marginTop: 0 }}>Export</h2>
        <p className="muted">
          A gzipped NDJSON archive: a manifest line, one line per row, an inventory of the stored
          artifacts and a closing summary that says how much the file should contain. Ingest token
          hashes and webhook signing secrets are left out.
        </p>
        <a className="btn" href={`/projects/${projectId}/settings/data/export`}>
          Download export
        </a>
        <p className="muted" style={{ fontSize: '0.85rem', marginBottom: 0 }}>
          The same archive is available to automation at{' '}
          <span className="mono">GET /v1/export</span> with a token carrying the{' '}
          <span className="mono">read</span> scope.
        </p>
      </div>

      <div className="card" style={{ marginBottom: '1.25rem' }}>
        <h2 style={{ marginTop: 0 }}>What this project is using</h2>
        <table>
          <tbody>
            <tr>
              <td>AI tokens today</td>
              <td className="muted">
                {usage.ai.budget > 0
                  ? `${usage.ai.spentToday.toLocaleString()} of ${usage.ai.budget.toLocaleString()}`
                  : `${usage.ai.spentToday.toLocaleString()} (no daily cap set)`}
                {usage.ai.exhausted ? (
                  <strong> — budget spent, root-cause analysis is paused until tomorrow</strong>
                ) : null}
              </td>
            </tr>
            <tr>
              <td>Root-cause reports today</td>
              <td className="muted">{usage.ai.reportsToday}</td>
            </tr>
            <tr>
              <td>Executions stored</td>
              <td className="muted">
                {usage.rows.executions.toLocaleString()} across {usage.rows.runs.toLocaleString()}{' '}
                runs and {usage.rows.identities.toLocaleString()} tests
              </td>
            </tr>
            <tr>
              <td>Artifacts</td>
              <td className="muted">
                {usage.artifacts
                  ? `${usage.artifacts.objects.toLocaleString()} objects, ${formatBytes(usage.artifacts.bytes)}`
                  : 'object storage is not configured'}
              </td>
            </tr>
            <tr>
              <td>Oldest execution</td>
              <td className="muted">
                {usage.oldestExecution ? formatDate(usage.oldestExecution) : '—'}
              </td>
            </tr>
          </tbody>
        </table>
        <p className="muted" style={{ fontSize: '0.85rem', marginBottom: 0 }}>
          The token budget stops root-cause analysis for the day when it runs out. Without this line
          a project that quietly stopped analysing looks exactly like one that had nothing to
          analyse.
        </p>
      </div>

      <div className="card" style={{ marginBottom: '1.25rem' }}>
        <h2 style={{ marginTop: 0 }}>Retention</h2>
        <table>
          <tbody>
            <tr>
              <td>Executions</td>
              <td className="muted">
                {retentionLabel(
                  policy?.executionRetentionDays,
                  process.env.FLAKEMETRY_EXECUTION_RETENTION_DAYS,
                )}
              </td>
            </tr>
            <tr>
              <td>Artifacts</td>
              <td className="muted">
                {retentionLabel(
                  policy?.artifactRetentionDays,
                  process.env.FLAKEMETRY_ARTIFACT_RETENTION_DAYS,
                )}
              </td>
            </tr>
          </tbody>
        </table>
        <p className="muted" style={{ fontSize: '0.85rem', marginBottom: 0 }}>
          Set these per project on the <a href={`/projects/${projectId}/settings/policy`}>Policy</a>{' '}
          page. Rolled-up daily statistics outlive the raw executions they were computed from.
        </p>
      </div>

      <div className="card" style={{ marginBottom: '1.25rem' }}>
        <h2 style={{ marginTop: 0 }}>Export and deletion history</h2>
        {requests.length === 0 ? (
          <div className="empty">Nothing yet.</div>
        ) : (
          <table>
            <thead>
              <tr>
                <th>When</th>
                <th>What</th>
                <th>Who</th>
                <th>Status</th>
                <th>Result</th>
              </tr>
            </thead>
            <tbody>
              {requests.map((request) => (
                <tr key={request.id}>
                  <td className="muted">{formatDate(request.createdAt)}</td>
                  <td>{request.kind}</td>
                  <td className="muted">{request.actor}</td>
                  <td>{request.status}</td>
                  <td className="muted">
                    {request.status === 'failed'
                      ? (request.error ?? 'failed')
                      : `${request.rowCount ?? 0} rows, ${request.artifactCount ?? 0} artifacts`}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      <div className="card" style={{ borderColor: 'var(--danger, #b91c1c)' }}>
        <h2 style={{ marginTop: 0 }}>Delete</h2>
        {pendingErasure ? (
          <div className="error-box">A deletion is already queued for this project.</div>
        ) : null}

        {isOwner ? (
          <>
            <p className="muted">
              Deleting removes every run, execution, score and stored artifact. It cannot be undone,
              and the export above is the only copy you will have.
            </p>

            <form
              action={requestProjectErasure}
              style={{ display: 'flex', gap: '0.75rem', marginBottom: '1.5rem' }}
            >
              <input type="hidden" name="projectId" value={projectId} />
              <input name="confirm" placeholder={`Type ${project.slug} to confirm`} />
              <button className="btn btn-danger" type="submit" style={{ whiteSpace: 'nowrap' }}>
                Delete this project
              </button>
            </form>

            <p className="muted">
              Deleting the workspace <strong>{project.orgName}</strong> removes every project in it,
              along with its members&apos; access.
            </p>

            <form action={requestWorkspaceErasure} style={{ display: 'flex', gap: '0.75rem' }}>
              <input type="hidden" name="projectId" value={projectId} />
              <input name="confirm" placeholder={`Type ${project.orgSlug} to confirm`} />
              <button className="btn btn-danger" type="submit" style={{ whiteSpace: 'nowrap' }}>
                Delete the whole workspace
              </button>
            </form>
          </>
        ) : (
          <p className="muted" style={{ marginBottom: 0 }}>
            Only the workspace owner can delete a project.
          </p>
        )}
      </div>
    </>
  )
}
