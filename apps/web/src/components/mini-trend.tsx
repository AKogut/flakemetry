export const MiniTrend = ({
  values,
  tone = 'var(--accent)',
  max,
  label,
}: {
  values: number[]
  tone?: string
  max?: number
  label?: string
}) => {
  if (values.length === 0) return <div className="muted">No data yet.</div>

  const ceiling = max ?? Math.max(...values, 1)
  const barWidth = 9
  const gap = 3
  const height = 34
  const width = values.length * (barWidth + gap) - gap

  return (
    <svg
      className="sparkline"
      width="100%"
      height={height}
      viewBox={`0 0 ${Math.max(width, 1)} ${height}`}
      preserveAspectRatio="none"
      role="img"
      aria-label={label ?? 'trend'}
    >
      {values.map((value, index) => {
        const barHeight = ceiling > 0 ? Math.max((value / ceiling) * height, 2) : 2
        return (
          <rect
            key={index}
            x={index * (barWidth + gap)}
            y={height - barHeight}
            width={barWidth}
            height={barHeight}
            rx={2}
            fill={tone}
          />
        )
      })}
    </svg>
  )
}
