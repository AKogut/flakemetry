import { relative } from 'node:path'

import type { ArtifactRef } from '@flakemetry/contracts'
import {
  buildIdempotencyKey,
  deliverRun,
  type FlakemetryDeliveryOptions,
  resolveRunContext,
  type RunContext,
  TestRunRecorder,
} from '@flakemetry/sdk'
import type {
  FullConfig,
  FullResult,
  Reporter,
  Suite,
  TestCase,
  TestResult,
} from '@playwright/test/reporter'

import { uploadArtifacts } from './artifacts'
import { findCodeowners, uploadCodeowners } from './codeowners'
import {
  deriveSuite,
  mapSteps,
  type PlaywrightStatus,
  statusFromResult,
  type SuiteNode,
} from './mapping'
import { findNotificationRouting, uploadNotificationRouting } from './notifications'

export type FlakemetryReporterOptions = FlakemetryDeliveryOptions

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
    this.context = resolveRunContext(this.env, config.shard)
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
      steps: mapSteps(result.steps ?? []),
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

    await this.maybeUploadArtifacts(idempotencyKey)
    await this.maybeUploadCodeowners()
    await this.maybeUploadNotificationRouting()

    await deliverRun(this.recorder, idempotencyKey, this.options, this.env)
  }

  private async maybeUploadCodeowners(): Promise<void> {
    const endpoint = this.options.endpoint ?? this.env.FLAKEMETRY_ENDPOINT
    const token = this.options.token ?? this.env.FLAKEMETRY_TOKEN
    if (!endpoint || !token) return

    try {
      const content = findCodeowners(this.rootDir, this.env)
      if (!content) return
      const ok = await uploadCodeowners({ endpoint, token, content })
      if (ok) process.stderr.write('flakemetry: synced CODEOWNERS\n')
    } catch (error) {
      process.stderr.write(
        `flakemetry: CODEOWNERS sync skipped (${error instanceof Error ? error.message : String(error)})\n`,
      )
    }
  }

  private async maybeUploadNotificationRouting(): Promise<void> {
    const endpoint = this.options.endpoint ?? this.env.FLAKEMETRY_ENDPOINT
    const token = this.options.token ?? this.env.FLAKEMETRY_TOKEN
    if (!endpoint || !token) return

    try {
      const routing = findNotificationRouting(this.rootDir)
      if (!routing) return
      const ok = await uploadNotificationRouting({ endpoint, token, routing })
      if (ok)
        process.stderr.write(
          `flakemetry: synced ${routing.channels.length} notification channel(s) from config\n`,
        )
    } catch (error) {
      process.stderr.write(
        `flakemetry: notification routing sync skipped (${error instanceof Error ? error.message : String(error)})\n`,
      )
    }
  }

  private async maybeUploadArtifacts(idempotencyKey: string): Promise<void> {
    const endpoint = this.options.endpoint ?? this.env.FLAKEMETRY_ENDPOINT
    const token = this.options.token ?? this.env.FLAKEMETRY_TOKEN
    if (!endpoint || !token || !this.recorder) return

    try {
      const { uploaded } = await uploadArtifacts({
        endpoint,
        token,
        idempotencyKey,
        rootDir: this.rootDir,
        executions: this.recorder.recorded,
      })
      if (uploaded > 0) process.stderr.write(`flakemetry: uploaded ${uploaded} artifact(s)\n`)
    } catch (error) {
      process.stderr.write(
        `flakemetry: artifact upload skipped (${error instanceof Error ? error.message : String(error)})\n`,
      )
    }
  }
}
