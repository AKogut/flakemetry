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
  searchParams: Promise<{ filter?: string }>
}) {
  const { projectId } = await params
  const { filter } = await searchParams
  const user = await requireUser()
  await requireProjectAccess(user.id, projectId)

  const board = await flakyBoard(prisma, projectId, {
    limit: BOARD_LIMIT,
    minScore: 0,
    includeQuarantined: true,
  })

  const items = board.items.filter((item) => {
    if (filter === 'candidates') return item.quarantineCandidate
    if (filter === 'rising') return item.trend === 'rising'
    return true
  })

  const base = `/projects/${projectId}/flaky`
  const tab = (key: string | undefined, label: string) => (
    <a
      href={key ? `${base}?filter=${key}` : base}
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
