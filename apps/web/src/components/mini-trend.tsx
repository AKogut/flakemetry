const MIN_SLOTS = 14

export const MiniTrend = ({
  values,
  tone = 'var(--accent)',
  max,
  label,
  flatMessage,
}: {
  values: number[]
  tone?: string
  max?: number
  label?: string
  flatMessage?: string
}) => {
  if (flatMessage && values.every((value) => value === 0)) {
    return <div className="muted">{flatMessage}</div>
  }
  if (values.length === 0) return <div className="muted">No data yet.</div>

  const ceiling = max ?? Math.max(...values, 1)
  const barWidth = 9
  const gap = 3
  const height = 34
  const slots = Math.max(values.length, MIN_SLOTS)
  const firstSlot = slots - values.length
  const width = slots * (barWidth + gap) - gap

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
            x={(firstSlot + index) * (barWidth + gap)}
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
