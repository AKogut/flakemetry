import type { TestStatus } from '@flakemetry/contracts'

const COLOR: Record<TestStatus, string> = {
  pass: 'var(--pass)',
  fail: 'var(--fail)',
  flaky: 'var(--flaky)',
  skip: 'var(--skip)',
}

export interface SparklinePoint {
  status: TestStatus
  commitSha: string
  startedAt: Date
}

export const Sparkline = ({ points }: { points: SparklinePoint[] }) => {
  if (points.length === 0) return <div className="muted">No history yet.</div>

  const barWidth = 9
  const gap = 3
  const height = 34
  const width = points.length * (barWidth + gap) - gap

  return (
    <svg
      className="sparkline"
      width="100%"
      height={height}
      viewBox={`0 0 ${Math.max(width, 1)} ${height}`}
      preserveAspectRatio="none"
      role="img"
      aria-label={`Last ${points.length} executions, oldest first`}
    >
      {points.map((point, index) => {
        const barHeight = point.status === 'skip' ? 8 : point.status === 'pass' ? 16 : height
        return (
          <rect
            key={`${point.commitSha}-${index}`}
            x={index * (barWidth + gap)}
            y={height - barHeight}
            width={barWidth}
            height={barHeight}
            rx={2}
            fill={COLOR[point.status]}
          >
            <title>{`${point.status} · ${point.commitSha.slice(0, 7)}`}</title>
          </rect>
        )
      })}
    </svg>
  )
}
