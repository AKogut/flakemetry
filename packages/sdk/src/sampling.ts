import type { IngestRunBatch } from '@flakemetry/contracts'

export interface SamplingOptions {
  sampleRate?: number
  rng?: () => number
}

const hasFailure = (batch: IngestRunBatch): boolean =>
  batch.run.status === 'failed' ||
  batch.run.status === 'running' ||
  batch.executions.some((execution) => execution.status === 'fail' || execution.status === 'flaky')

export const shouldDeliverRun = (batch: IngestRunBatch, options: SamplingOptions = {}): boolean => {
  const sampleRate = options.sampleRate ?? 1
  if (sampleRate >= 1) return true
  if (sampleRate <= 0) return hasFailure(batch)
  if (hasFailure(batch)) return true
  const rng = options.rng ?? Math.random
  return rng() < sampleRate
}
