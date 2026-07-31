import {
  buildIdempotencyKey,
  deliverRun,
  type FlakemetryDeliveryOptions,
  resolveRunContext,
  TestRunRecorder,
} from '@flakemetry/sdk'

import { mapVitestFiles, type VitestFile } from './mapping'

export type FlakemetryVitestReporterOptions = FlakemetryDeliveryOptions

export default class FlakemetryVitestReporter {
  private readonly options: FlakemetryVitestReporterOptions
  private readonly env: Record<string, string | undefined>
  private rootDir = process.cwd()

  constructor(options: FlakemetryVitestReporterOptions = {}) {
    this.options = options
    this.env = process.env
  }

  onInit(context?: { config?: { root?: string } }): void {
    if (context?.config?.root) this.rootDir = context.config.root
  }

  async onFinished(files: VitestFile[] = []): Promise<void> {
    const startedAt = new Date()
    const context = resolveRunContext(this.env)
    const recorder = new TestRunRecorder(context)
    recorder.startRun(startedAt)

    const cases = mapVitestFiles(files, this.rootDir, startedAt)
    for (const test of cases) recorder.record(test)

    const failed = cases.some((test) => test.status === 'fail')
    recorder.finishRun(failed ? 'failed' : 'passed', new Date())

    const idempotencyKey = buildIdempotencyKey(context, this.env)
    await deliverRun(recorder, idempotencyKey, this.options, this.env)
  }
}

export type { VitestFile, VitestTask, VitestTaskResult } from './mapping'
export { mapVitestFiles } from './mapping'
