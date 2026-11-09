import { getPrismaClient } from '@flakemetry/db'
import { countTestsWithoutSignal, flakyBoard, getEffectiveProjectPolicy } from '@flakemetry/queries'

import { ScoreBadge, TrendArrow } from '@/components/score'
import { formatPercent, formatWhen, testLocation } from '@/lib/format'
import { requireProjectViewer } from '@/lib/viewer'

const prisma = getPrismaClient()

const BOARD_LIMIT = 100

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

  const [board, policy, withoutSignal] = await Promise.all([
    flakyBoard(
      prisma,
      projectId,
      {
        limit: BOARD_LIMIT,
        minScore: 0,
        includeQuarantined: true,
        ...(owner ? { owner } : {}),
      },
      { withSignalOnly: true },
    ),
    getEffectiveProjectPolicy(prisma, projectId),
    countTestsWithoutSignal(prisma, projectId),
  ])

  const items = board.items.filter((item) => {
    if (filter === 'candidates') return item.quarantineCandidate
    if (filter === 'rising') return item.trend === 'rising'
    return true
  })

  const showOwner = items.some((item) => item.owners.length > 0)
  const showStatus = items.some((item) => item.quarantined || item.quarantineCandidate)

  const bar = policy.effective.flakyThreshold.value
  const highestScore = board.items[0]?.score ?? 0
  const emptyFilterMessage =
    filter === 'rising'
      ? 'No test is failing noticeably more often than it used to.'
      : highestScore >= bar
        ? `No test with enough runs has reached the quarantine bar, a flaky score of ${bar.toFixed(2)}.`
        : `No test has reached the quarantine bar, a flaky score of ${bar.toFixed(2)}. The highest score here is ${highestScore.toFixed(2)}.`

  const emptyBoardMessage = owner
    ? 'No ranked test has this owner.'
    : withoutSignal > 0
      ? 'No test here has a retry or a failure outside a run where most of the suite failed, so there is nothing to rank.'
      : 'No scored tests yet — ingest a few runs to build history.'

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
            {board.items.length === 0 ? emptyBoardMessage : emptyFilterMessage}
          </div>
        ) : (
          <table className="table-stack">
            <thead>
              <tr>
                <th>Score</th>
                <th>Test</th>
                {showOwner ? <th>Owner</th> : null}
                <th>Flip rate</th>
                <th>Pass on rerun</th>
                <th>Last flaked (UTC)</th>
                {showStatus ? <th>Status</th> : null}
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
                        {testLocation(item.suite, item.filePath)}
                      </div>
                    </a>
                  </td>
                  {showOwner ? (
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
                  ) : null}
                  <td className="muted" data-label="Flip rate">
                    {formatPercent(item.flipRate)}
                  </td>
                  <td className="muted" data-label="Pass on rerun">
                    {formatPercent(item.passOnRerunRate)}
                  </td>
                  <td className="muted" data-label="Last flaked">
                    {item.lastFlakedAt ? formatWhen(item.lastFlakedAt) : '—'}
                  </td>
                  {showStatus ? (
                    <td className="stack-optional" data-label="Status">
                      {item.quarantined ? (
                        <span className="pill pill-quarantined">quarantined</span>
                      ) : item.quarantineCandidate ? (
                        <span className="pill pill-candidate">candidate</span>
                      ) : (
                        <span className="muted">—</span>
                      )}
                    </td>
                  ) : null}
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

      {board.items.length > 0 && withoutSignal > 0 ? (
        <p className="muted" style={{ fontSize: '0.8rem', marginTop: '0.8rem' }}>
          {withoutSignal.toLocaleString()} {withoutSignal === 1 ? 'test is' : 'tests are'} not
          ranked: no retry and no failure outside a run where most of the suite failed.
        </p>
      ) : null}
    </>
  )
}
