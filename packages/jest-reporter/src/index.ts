import {
  buildIdempotencyKey,
  deliverRun,
  type FlakemetryDeliveryOptions,
  resolveRunContext,
  TestRunRecorder,
} from '@flakemetry/sdk'

import { type JestAggregatedResult, mapJestResults } from './mapping'

export type FlakemetryJestReporterOptions = FlakemetryDeliveryOptions

export default class FlakemetryJestReporter {
  private readonly options: FlakemetryJestReporterOptions
  private readonly env: Record<string, string | undefined>
  private readonly rootDir: string

  constructor(globalConfig?: { rootDir?: string }, options: FlakemetryJestReporterOptions = {}) {
    this.options = options
    this.env = process.env
    this.rootDir = globalConfig?.rootDir ?? process.cwd()
  }

  async onRunComplete(_contexts: unknown, results: JestAggregatedResult): Promise<void> {
    const startedAt = results.startTime != null ? new Date(results.startTime) : new Date()
    const context = resolveRunContext(this.env)
    const recorder = new TestRunRecorder(context)
    recorder.startRun(startedAt)

    const cases = mapJestResults(results, this.rootDir, startedAt)
    for (const test of cases) recorder.record(test)

    const failed = cases.some((test) => test.status === 'fail')
    recorder.finishRun(failed ? 'failed' : 'passed', new Date())

    const idempotencyKey = buildIdempotencyKey(context, this.env)
    await deliverRun(recorder, idempotencyKey, this.options, this.env)
  }
}

export type { JestAggregatedResult, JestAssertionResult, JestFileResult } from './mapping'
export { mapJestResults } from './mapping'
