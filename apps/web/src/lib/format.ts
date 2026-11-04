export const formatPercent = (value: number | null): string => {
  if (value === null) return '—'
  const percent = value * 100
  if (percent <= 0) return '0%'
  if (percent >= 100) return '100%'
  if (percent < 0.1) return '<0.1%'
  if (percent > 99.9) return '>99.9%'
  if (percent < 1 || percent > 99) return `${percent.toFixed(1)}%`
  return `${Math.round(percent)}%`
}

export const formatTestDuration = (ms: number | null): string => {
  if (ms === null) return '—'
  if (ms < 1) return '<1ms'
  if (ms < 1000) return `${Math.round(ms)}ms`
  return `${(ms / 1000).toFixed(1)}s`
}
