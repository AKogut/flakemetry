import { getPrismaClient } from '@flakemetry/db'
import { flakyBoard, getEffectiveProjectPolicy } from '@flakemetry/queries'

import { ScoreBadge, TrendArrow } from '@/components/score'
import { formatPercent } from '@/lib/format'
import { requireProjectViewer } from '@/lib/viewer'

const prisma = getPrismaClient()

const BOARD_LIMIT = 100

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
  await requireProjectViewer(projectId)

  const [board, policy] = await Promise.all([
    flakyBoard(prisma, projectId, {
      limit: BOARD_LIMIT,
      minScore: 0,
      includeQuarantined: true,
      ...(owner ? { owner } : {}),
    }),
    getEffectiveProjectPolicy(prisma, projectId),
  ])

  const items = board.items.filter((item) => {
    if (filter === 'candidates') return item.quarantineCandidate
    if (filter === 'rising') return item.trend === 'rising'
    return true
  })

  const bar = policy.effective.flakyThreshold.value
  const highestScore = board.items[0]?.score ?? 0
  const emptyFilterMessage =
    filter === 'rising'
      ? 'No test is failing noticeably more often than it used to.'
      : highestScore >= bar
        ? `No test with enough runs has reached the quarantine bar, a flaky score of ${bar.toFixed(2)}.`
        : `No test has reached the quarantine bar, a flaky score of ${bar.toFixed(2)}. The highest score here is ${highestScore.toFixed(2)}.`

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
              : emptyFilterMessage}
          </div>
        ) : (
          <table className="table-stack">
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
                  <td className="stack-main">
                    <a href={`/projects/${projectId}/tests/${item.testIdentityId}`}>
                      <div style={{ fontWeight: 600 }}>
                        {item.title}
                        {item.variant ? (
                          <span className="pill" style={{ marginLeft: '0.4rem' }}>
                            {item.variant}
                          </span>
                        ) : null}
                      </div>
                      <div className="muted mono" style={{ fontSize: '0.8rem' }}>
                        {item.suite} · {item.filePath}
                      </div>
                    </a>
                  </td>
                  <td className="muted stack-optional" data-label="Owner">
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
                  <td className="muted" data-label="Flip rate">
                    {formatPercent(item.flipRate)}
                  </td>
                  <td className="muted" data-label="Pass on rerun">
                    {formatPercent(item.passOnRerunRate)}
                  </td>
                  <td className="muted" data-label="Last flaked">
                    {formatWhen(item.lastFlakedAt)}
                  </td>
                  <td className="stack-optional" data-label="Status">
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
