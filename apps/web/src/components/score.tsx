import type { FlakyTrend, ReasonCode } from '@flakemetry/contracts'

export const scoreTone = (score: number): string =>
  score >= 0.8 ? 'var(--fail)' : score >= 0.4 ? 'var(--flaky)' : 'var(--pass)'

export const ScoreBadge = ({ score }: { score: number | null }) => {
  if (score == null) return <span className="muted">—</span>
  return (
    <span className="score-badge" style={{ color: scoreTone(score) }}>
      {score.toFixed(2)}
    </span>
  )
}

const TREND_LABEL: Record<FlakyTrend, string> = {
  rising: 'getting worse',
  falling: 'improving',
  stable: 'stable',
}

const TREND_GLYPH: Record<FlakyTrend, string> = {
  rising: '▲',
  falling: '▼',
  stable: '–',
}

const TREND_TONE: Record<FlakyTrend, string> = {
  rising: 'var(--fail)',
  falling: 'var(--pass)',
  stable: 'var(--muted)',
}

export const TrendArrow = ({ trend }: { trend: FlakyTrend }) => (
  <span style={{ color: TREND_TONE[trend] }} title={TREND_LABEL[trend]}>
    {TREND_GLYPH[trend]}
  </span>
)

export const ReasonCodes = ({ codes }: { codes: ReasonCode[] }) => {
  if (codes.length === 0) return <p className="muted">No reason codes recorded.</p>

  return (
    <ul className="reasons">
      {codes.map((reason) => (
        <li key={reason.code}>
          <span className={`reason-code${reason.code === 'STABLE' ? ' reason-stable' : ''}`}>
            {reason.code}
          </span>
          <span className="muted">{reason.message}</span>
        </li>
      ))}
    </ul>
  )
}
