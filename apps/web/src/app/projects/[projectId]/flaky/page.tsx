import { getPrismaClient } from '@flakemetry/db'
import { flakyBoard } from '@flakemetry/queries'

import { ScoreBadge, TrendArrow } from '@/components/score'
import { requireUser } from '@/lib/session'
import { requireProjectAccess } from '@/lib/tenant'

const prisma = getPrismaClient()

const BOARD_LIMIT = 100

const percent = (value: number): string => `${Math.round(value * 100)}%`

const formatWhen = (date: Date | null): string =>
  date
    ? new Intl.DateTimeFormat('en', { month: 'short', day: 'numeric', hour: '2-digit' }).format(
        date,
      )
    : '—'

export default async function FlakyBoardPage({
  params,
  searchParams,
}: {
  params: Promise<{ projectId: string }>
  searchParams: Promise<{ filter?: string; owner?: string }>
}) {
  const { projectId } = await params
  const { filter, owner } = await searchParams
  const user = await requireUser()
  await requireProjectAccess(user.id, projectId)

  const board = await flakyBoard(prisma, projectId, {
    limit: BOARD_LIMIT,
    minScore: 0,
    includeQuarantined: true,
    ...(owner ? { owner } : {}),
  })

  const items = board.items.filter((item) => {
    if (filter === 'candidates') return item.quarantineCandidate
    if (filter === 'rising') return item.trend === 'rising'
    return true
  })

  const base = `/projects/${projectId}/flaky`
  const hrefWith = (patch: { filter?: string; owner?: string }): string => {
    const next = new URLSearchParams()
    const nextFilter = 'filter' in patch ? patch.filter : filter
    const nextOwner = 'owner' in patch ? patch.owner : owner
    if (nextFilter) next.set('filter', nextFilter)
    if (nextOwner) next.set('owner', nextOwner)
    const qs = next.toString()
    return qs ? `${base}?${qs}` : base
  }
  const tab = (key: string | undefined, label: string) => (
    <a
      href={hrefWith({ filter: key })}
      className="filter-tab"
      data-active={(filter ?? '') === (key ?? '')}
    >
      {label}
    </a>
  )

  return (
    <>
      <h1 className="page-title">Flaky board</h1>
      <p className="page-subtitle">
        Tests ranked by how much they are eroding trust, with the signals behind each score.
      </p>

      <div className="filters">
        {tab(undefined, 'All')}
        {tab('candidates', 'Quarantine candidates')}
        {tab('rising', 'Getting worse')}
      </div>

      {owner ? (
        <p className="muted" style={{ marginTop: '0.6rem' }}>
          Filtered to tests owned by <span className="mono">{owner}</span> ·{' '}
          <a href={hrefWith({ owner: undefined })}>clear</a>
        </p>
      ) : null}

      <div className="card">
        {items.length === 0 ? (
          <div className="empty">
            {board.items.length === 0
              ? 'No scored tests yet — ingest a few runs to build history.'
              : 'No tests match this filter.'}
          </div>
        ) : (
          <table>
            <thead>
              <tr>
                <th>Score</th>
                <th>Test</th>
                <th>Owner</th>
                <th>Flip rate</th>
                <th>Pass on rerun</th>
                <th>Last flaked</th>
                <th>Status</th>
              </tr>
            </thead>
            <tbody>
              {items.map((item) => (
                <tr key={item.testIdentityId}>
                  <td>
                    <span style={{ display: 'inline-flex', gap: '0.4rem', alignItems: 'center' }}>
                      <ScoreBadge score={item.score} />
                      <TrendArrow trend={item.trend} />
                    </span>
                  </td>
                  <td>
                    <a href={`/projects/${projectId}/tests/${item.testIdentityId}`}>
                      <div style={{ fontWeight: 600 }}>{item.title}</div>
                      <div className="muted mono" style={{ fontSize: '0.8rem' }}>
                        {item.suite} · {item.filePath}
                      </div>
                    </a>
                  </td>
                  <td className="muted">
                    {item.owners.length === 0 ? (
                      <span className="muted">—</span>
                    ) : (
                      item.owners.map((ownerHandle) => (
                        <a
                          key={ownerHandle}
                          href={hrefWith({ owner: ownerHandle })}
                          className="mono"
                          style={{ marginRight: '0.4rem' }}
                        >
                          {ownerHandle}
                        </a>
                      ))
                    )}
                  </td>
                  <td className="muted">{percent(item.flipRate)}</td>
                  <td className="muted">{percent(item.passOnRerunRate)}</td>
                  <td className="muted">{formatWhen(item.lastFlakedAt)}</td>
                  <td>
                    {item.quarantined ? (
                      <span className="pill pill-quarantined">quarantined</span>
                    ) : item.quarantineCandidate ? (
                      <span className="pill pill-candidate">candidate</span>
                    ) : (
                      <span className="muted">—</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {board.items.length === BOARD_LIMIT ? (
        <p className="muted" style={{ fontSize: '0.8rem', marginTop: '0.8rem' }}>
          Showing the top {BOARD_LIMIT} scored tests.
        </p>
      ) : null}
    </>
  )
}
