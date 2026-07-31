import { randomUUID } from 'node:crypto'
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

import type { CiProvider, IngestRunBatch, RunTrigger, TestStatus } from '@flakemetry/contracts'

import { uploadArtifacts } from './artifacts'
import { IngestClient } from './client'
import { findCodeowners, uploadCodeowners } from './codeowners'
import { exportRunOverOtlp } from './exporter'
import { findNotificationRouting, uploadNotificationRouting } from './notifications'
import type { RunContext, TestRunRecorder } from './recorder'
import { shouldDeliverRun } from './sampling'

export interface ShardInfo {
  current: number
  total: number
}

const prNumberFromRef = (ref: string | undefined): number | null => {
  if (!ref) return null
  const match = /refs\/pull\/(\d+)\//.exec(ref)
  return match ? Number(match[1]) : null
}

const pick = (value: string | undefined): string | undefined =>
  value && value.length > 0 ? value : undefined

export const resolveRunContext = (
  env: Record<string, string | undefined>,
  shard?: ShardInfo | null,
): RunContext => {
  const onGithub = env.GITHUB_ACTIONS === 'true'
  const ciProvider: CiProvider = onGithub ? 'github_actions' : 'local'
  const trigger: RunTrigger = onGithub
    ? env.GITHUB_EVENT_NAME === 'pull_request'
      ? 'pull_request'
      : env.GITHUB_EVENT_NAME === 'schedule'
        ? 'schedule'
        : 'push'
    : 'manual'

  return {
    project: pick(env.FLAKEMETRY_PROJECT) ?? 'local/project',
    commitSha: pick(env.GITHUB_SHA) ?? pick(env.FLAKEMETRY_COMMIT_SHA) ?? '0000000',
    branch: pick(env.GITHUB_REF_NAME) ?? pick(env.FLAKEMETRY_BRANCH) ?? 'local',
    ciProvider,
    trigger,
    ciRunId: pick(env.GITHUB_RUN_ID) ?? null,
    prNumber: prNumberFromRef(pick(env.GITHUB_REF)),
    shardIndex: shard && shard.total > 1 ? shard.current : null,
    shardTotal: shard && shard.total > 1 ? shard.total : null,
  }
}

export const buildIdempotencyKey = (
  context: RunContext,
  env: Record<string, string | undefined>,
): string => {
  const explicit = env.FLAKEMETRY_IDEMPOTENCY_KEY
  if (explicit) return explicit
  if (context.ciRunId) {
    const attempt = env.GITHUB_RUN_ATTEMPT ?? '1'
    const shard = context.shardIndex != null ? `-shard${context.shardIndex}` : ''
    return `${context.ciProvider}-${context.ciRunId}-${attempt}${shard}`
  }
  return `local-${randomUUID()}`
}

export interface FlakemetryDeliveryOptions {
  endpoint?: string
  token?: string
  outputFile?: string
  transport?: 'otlp' | 'json'
  bufferDir?: string | null
  sampleRate?: number
  rng?: () => number
}

const resolveSampleRate = (
  options: FlakemetryDeliveryOptions,
  env: Record<string, string | undefined>,
): number => {
  if (options.sampleRate != null) return options.sampleRate
  const parsed = env.FLAKEMETRY_SAMPLE_RATE ? Number(env.FLAKEMETRY_SAMPLE_RATE) : NaN
  return Number.isFinite(parsed) ? parsed : 1
}

const writeOutput = (
  batch: IngestRunBatch,
  options: FlakemetryDeliveryOptions,
  env: Record<string, string | undefined>,
): void => {
  const outputFile = options.outputFile ?? env.FLAKEMETRY_OUTPUT_FILE
  if (!outputFile) return
  mkdirSync(dirname(outputFile), { recursive: true })
  writeFileSync(outputFile, JSON.stringify(batch, null, 2))
}

const syncReporterConfig = async (
  recorder: TestRunRecorder,
  idempotencyKey: string,
  endpoint: string,
  token: string,
  rootDir: string,
  env: Record<string, string | undefined>,
): Promise<void> => {
  try {
    const { uploaded } = await uploadArtifacts({
      endpoint,
      token,
      idempotencyKey,
      rootDir,
      executions: recorder.recorded,
    })
    if (uploaded > 0) process.stderr.write(`flakemetry: uploaded ${uploaded} artifact(s)\n`)
  } catch (error) {
    process.stderr.write(
      `flakemetry: artifact upload skipped (${error instanceof Error ? error.message : String(error)})\n`,
    )
  }

  try {
    const content = findCodeowners(rootDir, env)
    if (content) {
      const ok = await uploadCodeowners({ endpoint, token, content })
      if (ok) process.stderr.write('flakemetry: synced CODEOWNERS\n')
    }
  } catch (error) {
    process.stderr.write(
      `flakemetry: CODEOWNERS sync skipped (${error instanceof Error ? error.message : String(error)})\n`,
    )
  }

  try {
    const routing = findNotificationRouting(rootDir)
    if (routing) {
      const ok = await uploadNotificationRouting({ endpoint, token, routing })
      if (ok) {
        process.stderr.write(
          `flakemetry: synced ${routing.channels.length} notification channel(s) from config\n`,
        )
      }
    }
  } catch (error) {
    process.stderr.write(
      `flakemetry: notification routing sync skipped (${error instanceof Error ? error.message : String(error)})\n`,
    )
  }
}

export const deliverRun = async (
  recorder: TestRunRecorder,
  idempotencyKey: string,
  options: FlakemetryDeliveryOptions,
  env: Record<string, string | undefined>,
  rootDir: string = process.cwd(),
): Promise<void> => {
  const batch = recorder.toIngestBatch(idempotencyKey)
  writeOutput(batch, options, env)

  const endpoint = options.endpoint ?? env.FLAKEMETRY_ENDPOINT
  const token = options.token ?? env.FLAKEMETRY_TOKEN
  if (!endpoint || !token) return

  await syncReporterConfig(recorder, idempotencyKey, endpoint, token, rootDir, env)

  const bufferDir = options.bufferDir ?? env.FLAKEMETRY_BUFFER_DIR ?? null
  const client = new IngestClient({ endpoint, token, bufferDir })
  if (bufferDir) {
    const { flushed } = await client.flushBuffered()
    if (flushed > 0) process.stderr.write(`flakemetry: flushed ${flushed} buffered run(s)\n`)
  }

  if (!shouldDeliverRun(batch, { sampleRate: resolveSampleRate(options, env), rng: options.rng })) {
    return
  }

  const transport = options.transport ?? (env.FLAKEMETRY_TRANSPORT === 'json' ? 'json' : 'otlp')
  if (transport === 'otlp') {
    try {
      await exportRunOverOtlp(recorder, idempotencyKey, {
        endpoint,
        token,
        compression: env.FLAKEMETRY_COMPRESSION === 'gzip',
      })
      return
    } catch (error) {
      process.stderr.write(
        `flakemetry: otlp export failed, falling back to json (${error instanceof Error ? error.message : String(error)})\n`,
      )
    }
  }

  const outcome = await client.send(batch)
  if (!outcome.ok) {
    process.stderr.write(
      `flakemetry: upload skipped (${outcome.error ?? `status ${outcome.status}`}${outcome.buffered ? ', buffered' : ''})\n`,
    )
  }
}

const VALID_STATUSES: readonly TestStatus[] = ['pass', 'fail', 'flaky', 'skip']

export const assertConformantBatch = (batch: IngestRunBatch): void => {
  if (batch.executions.length === 0) {
    throw new Error('conformance: batch has no executions')
  }
  for (const execution of batch.executions) {
    if (!execution.filePath || !execution.title) {
      throw new Error('conformance: execution is missing identity (filePath/title)')
    }
    if (!VALID_STATUSES.includes(execution.status)) {
      throw new Error(`conformance: execution has an invalid status "${execution.status}"`)
    }
    if ((execution.attempt ?? 1) < 1) {
      throw new Error('conformance: execution attempt must be >= 1')
    }
  }
}
