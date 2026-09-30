import { getPrismaClient } from '@flakemetry/db'
import { formatBytes, getWorkspaceUsage } from '@flakemetry/queries'
import { projectArtifactPrefix, resolveObjectStore } from '@flakemetry/storage'

import { requireUser } from '@/lib/session'

const prisma = getPrismaClient()

const MEGABYTE = 1024 * 1024

const ofCap = (used: string, cap: number, format: (value: number) => string): string =>
  cap > 0 ? `${used} / ${format(cap)}` : used

export default async function UsagePage() {
  const user = await requireUser()
  const memberships = await prisma.membership.findMany({
    where: { userId: user.id, role: { in: ['owner', 'admin'] } },
    select: { orgId: true },
  })
  const store = resolveObjectStore(process.env)
  const rows = await getWorkspaceUsage(
    prisma,
    memberships.map((membership) => membership.orgId),
    {
      artifactsFor: (orgId, projectId) =>
        store ? { prefix: projectArtifactPrefix(orgId, projectId), store } : null,
    },
  )

  const workspaces = new Map<string, { name: string; rows: typeof rows }>()
  for (const row of rows) {
    const existing = workspaces.get(row.orgId)
    if (existing) existing.rows.push(row)
    else workspaces.set(row.orgId, { name: row.orgName, rows: [row] })
  }

  return (
    <div className="container">
      <h1 className="page-title">Usage</h1>
      <p className="page-subtitle">
        What each project in the workspaces you administer is spending on AI analysis and storage,
        against the caps set on its Policy page or by the environment. Over a storage cap, the next
        retention sweep trims the oldest data; over the AI budget, analysis pauses until midnight
        UTC.
      </p>

      {workspaces.size === 0 ? (
        <div className="card">
          <p className="muted" style={{ margin: 0 }}>
            You are not an owner or admin of any workspace, so there is nothing to show here.
          </p>
        </div>
      ) : null}

      {[...workspaces.entries()].map(([orgId, workspace]) => (
        <div className="card" key={orgId} style={{ marginBottom: '1.25rem' }}>
          <h2 style={{ marginTop: 0 }}>{workspace.name}</h2>
          <table>
            <thead>
              <tr>
                <th>Project</th>
                <th>AI tokens today</th>
                <th>Raw executions (hot)</th>
                <th>Daily rollups (cold)</th>
                <th>Artifacts</th>
              </tr>
            </thead>
            <tbody>
              {workspace.rows.map((row) => (
                <tr key={row.projectId}>
                  <td>
                    <a href={`/projects/${row.projectId}/settings/data`}>{row.projectName}</a>
                  </td>
                  <td
                    className="mono"
                    style={{ color: row.usage.ai.exhausted ? 'var(--flaky)' : undefined }}
                  >
                    {row.usage.ai.analysisOff
                      ? 'analysis off'
                      : ofCap(
                          row.usage.ai.spentToday.toLocaleString(),
                          row.caps.aiDailyTokenBudget,
                          (n) => n.toLocaleString(),
                        )}
                  </td>
                  <td
                    className="mono"
                    style={{ color: row.overExecutionCap ? 'var(--fail)' : undefined }}
                  >
                    {ofCap(
                      row.usage.rows.executions.toLocaleString(),
                      row.caps.storageMaxExecutions,
                      (n) => n.toLocaleString(),
                    )}
                  </td>
                  <td className="mono">{row.usage.rows.rollups.toLocaleString()}</td>
                  <td
                    className="mono"
                    style={{ color: row.overArtifactCap ? 'var(--fail)' : undefined }}
                  >
                    {row.usage.artifacts
                      ? ofCap(
                          formatBytes(row.usage.artifacts.bytes),
                          row.caps.storageMaxArtifactMb * MEGABYTE,
                          formatBytes,
                        )
                      : '—'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="muted" style={{ fontSize: '0.8rem', marginBottom: 0 }}>
            Caps are set per project under <strong>Settings → Policy</strong>. A figure in red is
            over its cap.
          </p>
        </div>
      ))}
    </div>
  )
}
