const MIN_SAMPLES = 5
const FACTOR = 3
const FLOOR_MS = 500

const median = (values) => {
  const sorted = [...values].sort((a, b) => a - b)
  const middle = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 1 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2
}

const seconds = (ms) => `${(ms / 1000).toFixed(1)}s`

export default {
  name: 'slow-outlier',
  apiVersion: 1,
  async analyze(input, context) {
    const candidates = input.executions.filter(
      (execution) =>
        execution.status === 'pass' && execution.attempt === 1 && execution.durationMs >= FLOOR_MS,
    )
    if (candidates.length === 0) return []

    const history = await context.history(
      candidates.map((execution) => execution.testIdentityId),
      { limit: 20 },
    )

    const signals = []
    for (const execution of candidates) {
      const durations = (history[execution.testIdentityId] ?? [])
        .filter((entry) => entry.status === 'pass' && entry.attempt === 1)
        .map((entry) => entry.durationMs)
      if (durations.length < MIN_SAMPLES) continue

      const typical = median(durations)
      if (typical <= 0 || execution.durationMs < typical * FACTOR) continue

      signals.push({
        testIdentityId: execution.testIdentityId,
        code: 'SLOW_OUTLIER',
        severity: 'warning',
        message: `took ${seconds(execution.durationMs)}, ${(execution.durationMs / typical).toFixed(1)}× its median of ${seconds(typical)} over the last ${durations.length} passing runs`,
        data: { durationMs: execution.durationMs, medianMs: typical, samples: durations.length },
      })
    }
    return signals
  },
}
