import { getPrismaClient } from '@flakemetry/db'

import { createIngestToken, revokeIngestToken } from '@/lib/actions'
import { requireUser } from '@/lib/session'
import { requireProjectAccess } from '@/lib/tenant'

const prisma = getPrismaClient()

const formatDate = (date: Date | null): string =>
  date
    ? new Intl.DateTimeFormat('en', { month: 'short', day: 'numeric', year: 'numeric' }).format(
        date,
      )
    : '—'

export default async function TokensPage({
  params,
  searchParams,
}: {
  params: Promise<{ projectId: string }>
  searchParams: Promise<{ created?: string }>
}) {
  const { projectId } = await params
  const { created } = await searchParams
  const user = await requireUser()
  await requireProjectAccess(user.id, projectId)

  const tokens = await prisma.ingestToken.findMany({
    where: { projectId },
    orderBy: { createdAt: 'desc' },
    select: { id: true, name: true, lastUsedAt: true, revokedAt: true, createdAt: true },
  })

  return (
    <>
      <h1 className="page-title">Ingest tokens</h1>
      <p className="page-subtitle">
        A token authorizes one project to send test runs. Store it as{' '}
        <span className="mono">FLAKEMETRY_TOKEN</span> in your CI secrets.
      </p>

      {created ? (
        <div className="card" style={{ marginBottom: '1.25rem', borderColor: 'var(--accent)' }}>
          <strong>Copy this token now — it is shown only once.</strong>
          <div className="token-value mono">{created}</div>
          <div className="muted" style={{ fontSize: '0.85rem' }}>
            Flakemetry stores only a hash, so it cannot be recovered later.
          </div>
        </div>
      ) : null}

      <div className="card" style={{ marginBottom: '1.25rem' }}>
        <form action={createIngestToken} style={{ display: 'flex', gap: '0.75rem' }}>
          <input type="hidden" name="projectId" value={projectId} />
          <input name="name" placeholder="Token name (e.g. github-actions)" />
          <button className="btn" type="submit" style={{ whiteSpace: 'nowrap' }}>
            Create token
          </button>
        </form>
      </div>

      <div className="card">
        {tokens.length === 0 ? (
          <div className="empty">No tokens yet.</div>
        ) : (
          <table>
            <thead>
              <tr>
                <th>Name</th>
                <th>Created</th>
                <th>Last used</th>
                <th>Status</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {tokens.map((token) => (
                <tr key={token.id}>
                  <td>{token.name}</td>
                  <td className="muted">{formatDate(token.createdAt)}</td>
                  <td className="muted">{formatDate(token.lastUsedAt)}</td>
                  <td>
                    {token.revokedAt ? (
                      <span className="muted">revoked</span>
                    ) : (
                      <span className="status">
                        <span className="dot dot-passed" />
                        active
                      </span>
                    )}
                  </td>
                  <td style={{ textAlign: 'right' }}>
                    {token.revokedAt ? null : (
                      <form action={revokeIngestToken}>
                        <input type="hidden" name="projectId" value={projectId} />
                        <input type="hidden" name="tokenId" value={token.id} />
                        <button className="btn btn-danger" type="submit">
                          Revoke
                        </button>
                      </form>
                    )}
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
