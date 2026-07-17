import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, relative } from 'node:path'

import type { ArtifactRef, IngestRunBatch } from '@flakemetry/contracts'
import { exportRunOverOtlp, IngestClient, type RunContext, TestRunRecorder } from '@flakemetry/sdk'
import type {
  FullConfig,
  FullResult,
  Reporter,
  Suite,
  TestCase,
  TestResult,
} from '@playwright/test/reporter'

import {
  buildIdempotencyKey,
  deriveSuite,
  type PlaywrightStatus,
  resolveRunContext,
  statusFromResult,
  type SuiteNode,
} from './mapping'

export interface FlakemetryReporterOptions {
  endpoint?: string
  token?: string
  outputFile?: string
  transport?: 'otlp' | 'json'
  bufferDir?: string | null
}

const collectAncestors = (test: TestCase): SuiteNode[] => {
  const ancestors: SuiteNode[] = []
  let current: Suite | undefined = test.parent
  while (current) {
    ancestors.unshift({ type: current.type, title: current.title })
    current = current.parent
  }
  return ancestors
}

export default class FlakemetryReporter implements Reporter {
  private readonly options: FlakemetryReporterOptions
  private readonly env: Record<string, string | undefined>
  private recorder: TestRunRecorder | null = null
  private context: RunContext | null = null
  private rootDir = process.cwd()
  private readonly firstAttemptIndex = new Map<string, number>()

  constructor(options: FlakemetryReporterOptions = {}) {
    this.options = options
    this.env = process.env
  }

  onBegin(config: FullConfig, _suite: Suite): void {
    this.rootDir = config.rootDir
    this.context = resolveRunContext(this.env)
    this.recorder = new TestRunRecorder(this.context)
    this.recorder.startRun(new Date())
  }

  onTestEnd(test: TestCase, result: TestResult): void {
    if (!this.recorder) return
    const index = this.recorder.recorded.length
    const attempt = result.retry + 1
    const retryOfIndex = attempt > 1 ? (this.firstAttemptIndex.get(test.id) ?? null) : null
    const error = result.error
      ? {
          type: result.error.value ?? undefined,
          message: result.error.message ?? 'unknown error',
          stack: result.error.stack ?? undefined,
        }
      : null

    this.recorder.record({
      filePath: relative(this.rootDir, test.location.file),
      suite: deriveSuite(collectAncestors(test)),
      title: test.title,
      status: statusFromResult(result.status as PlaywrightStatus, result.retry),
      attempt,
      retryOfIndex,
      startedAt: result.startTime,
      durationMs: Math.round(result.duration),
      error,
      artifacts: this.collectArtifacts(result),
    })

    if (attempt === 1) this.firstAttemptIndex.set(test.id, index)
  }

  private collectArtifacts(result: TestResult): ArtifactRef[] {
    return (result.attachments ?? [])
      .filter((attachment): attachment is TestResult['attachments'][number] & { path: string } =>
        Boolean(attachment.path),
      )
      .map((attachment) => ({
        name: attachment.name,
        contentType: attachment.contentType,
        path: relative(this.rootDir, attachment.path),
      }))
  }

  async onEnd(result: FullResult): Promise<void> {
    if (!this.recorder || !this.context) return
    this.recorder.finishRun(result.status === 'passed' ? 'passed' : 'failed', new Date())
    const idempotencyKey = buildIdempotencyKey(this.context, this.env)
    const batch = this.recorder.toIngestBatch(idempotencyKey)

    this.writeOutput(batch)
    await this.deliver(this.recorder, batch, idempotencyKey)
  }

  private writeOutput(batch: IngestRunBatch): void {
    const outputFile = this.options.outputFile ?? this.env.FLAKEMETRY_OUTPUT_FILE
    if (!outputFile) return
    mkdirSync(dirname(outputFile), { recursive: true })
    writeFileSync(outputFile, JSON.stringify(batch, null, 2))
  }

  private async deliver(
    recorder: TestRunRecorder,
    batch: IngestRunBatch,
    idempotencyKey: string,
  ): Promise<void> {
    const endpoint = this.options.endpoint ?? this.env.FLAKEMETRY_ENDPOINT
    const token = this.options.token ?? this.env.FLAKEMETRY_TOKEN
    if (!endpoint || !token) return

    const transport =
      this.options.transport ?? (this.env.FLAKEMETRY_TRANSPORT === 'json' ? 'json' : 'otlp')
    if (transport === 'otlp') {
      try {
        await exportRunOverOtlp(recorder, idempotencyKey, { endpoint, token })
        return
      } catch (error) {
        process.stderr.write(
          `flakemetry: otlp export failed, falling back to json (${error instanceof Error ? error.message : String(error)})\n`,
        )
      }
    }

    const client = new IngestClient({ endpoint, token, bufferDir: this.bufferDir() })
    const outcome = await client.send(batch)
    if (!outcome.ok) {
      process.stderr.write(
        `flakemetry: upload skipped (${outcome.error ?? `status ${outcome.status}`}${outcome.buffered ? ', buffered' : ''})\n`,
      )
    }
  }

  private bufferDir(): string | null {
    return this.options.bufferDir ?? this.env.FLAKEMETRY_BUFFER_DIR ?? null
  }
}
