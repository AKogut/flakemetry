export const MiniTrend = ({
  values,
  tone = 'var(--accent)',
  max,
  label,
}: {
  values: (number | null)[]
  tone?: string
  max?: number
  label?: string
}) => {
  const present = values.filter((value): value is number => value !== null)
  if (present.length === 0) return <div className="muted">No data yet.</div>

  const ceiling = max ?? Math.max(...present, 1)
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
        if (value === null) return null
        const barHeight = ceiling > 0 ? Math.max((value / ceiling) * height, 2) : 2
        return (
          <rect
            key={index}
            x={index * (barWidth + gap)}
            y={height - barHeight}
            width={barWidth}
            height={barHeight}
            rx={2}
            fill={value === 0 ? 'var(--border)' : tone}
          />
        )
      })}
    </svg>
  )
}
