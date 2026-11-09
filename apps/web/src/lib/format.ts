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

export const formatExecutionDuration = (execution: {
  status: string
  durationMs: number
  durationKnown: boolean
}): string =>
  execution.status === 'skip' || !execution.durationKnown
    ? '—'
    : formatTestDuration(execution.durationMs)

const UTC_DATE_TIME = new Intl.DateTimeFormat('en', {
  month: 'short',
  day: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
  hour12: false,
  timeZone: 'UTC',
})

export const formatWhen = (date: Date): string => UTC_DATE_TIME.format(date)

export const NO_SUITE_LABEL = 'No suite'

export const suiteName = (suite: string): string => suite || NO_SUITE_LABEL

export const testLocation = (suite: string, filePath: string): string =>
  [...new Set([suite, filePath].filter(Boolean))].join(' · ')
