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

const asNumber = (value: string | undefined): number | null => {
  if (!value) return null
  const parsed = Number(value)
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null
}

interface CiSignals {
  provider: CiProvider
  commitSha?: string
  branch?: string
  runId?: string
  attempt?: string
  prNumber: number | null
  trigger: RunTrigger
  shardIndex?: number | null
  shardTotal?: number | null
}

type Env = Record<string, string | undefined>

/**
 * Every provider below already had a value in the CiProvider enum and nothing that ever
 * produced it. A run outside GitHub Actions arrived as `local` at commit "0000000" on
 * branch "local", which collapses a project's whole history onto one commit — and
 * scoring reads "same commit, different result" as flakiness, so it manufactured that
 * signal for every test. The pull-request gate and shard correlation were equally blind.
 */
const DETECTORS: ((env: Env) => CiSignals | null)[] = [
  (env) =>
    env.GITHUB_ACTIONS === 'true'
      ? {
          provider: 'github_actions',
          commitSha: pick(env.GITHUB_SHA),
          branch: pick(env.GITHUB_REF_NAME),
          runId: pick(env.GITHUB_RUN_ID),
          attempt: pick(env.GITHUB_RUN_ATTEMPT),
          prNumber: prNumberFromRef(pick(env.GITHUB_REF)),
          trigger:
            env.GITHUB_EVENT_NAME === 'pull_request'
              ? 'pull_request'
              : env.GITHUB_EVENT_NAME === 'schedule'
                ? 'schedule'
                : 'push',
        }
      : null,

  (env) =>
    env.GITLAB_CI === 'true'
      ? {
          provider: 'gitlab_ci',
          commitSha: pick(env.CI_COMMIT_SHA),
          branch: pick(env.CI_COMMIT_REF_NAME),
          runId: pick(env.CI_PIPELINE_ID),
          attempt: pick(env.CI_JOB_ID),
          prNumber: asNumber(pick(env.CI_MERGE_REQUEST_IID)),
          trigger:
            env.CI_PIPELINE_SOURCE === 'merge_request_event'
              ? 'pull_request'
              : env.CI_PIPELINE_SOURCE === 'schedule'
                ? 'schedule'
                : 'push',
          shardIndex: asNumber(pick(env.CI_NODE_INDEX)),
          shardTotal: asNumber(pick(env.CI_NODE_TOTAL)),
        }
      : null,

  (env) =>
    env.CIRCLECI === 'true'
      ? {
          provider: 'circleci',
          commitSha: pick(env.CIRCLE_SHA1),
          branch: pick(env.CIRCLE_BRANCH),
          runId: pick(env.CIRCLE_WORKFLOW_ID) ?? pick(env.CIRCLE_BUILD_NUM),
          attempt: pick(env.CIRCLE_BUILD_NUM),
          // CIRCLE_PULL_REQUEST is the pull request URL, not its number.
          prNumber: asNumber(/\/(\d+)\/?$/.exec(env.CIRCLE_PULL_REQUEST ?? '')?.[1]),
          trigger: env.CIRCLE_PULL_REQUEST ? 'pull_request' : 'push',
          // CircleCI numbers parallel containers from zero; Flakemetry counts from one.
          shardIndex: (() => {
            const raw = env.CIRCLE_NODE_INDEX
            if (raw === undefined || raw === '') return null
            const parsed = Number(raw)
            return Number.isInteger(parsed) && parsed >= 0 ? parsed + 1 : null
          })(),
          shardTotal: asNumber(pick(env.CIRCLE_NODE_TOTAL)),
        }
      : null,

  (env) =>
    pick(env.JENKINS_URL)
      ? {
          provider: 'jenkins',
          commitSha: pick(env.GIT_COMMIT),
          branch: pick(env.BRANCH_NAME) ?? pick(env.GIT_BRANCH),
          runId: pick(env.BUILD_ID) ?? pick(env.BUILD_NUMBER),
          attempt: pick(env.BUILD_NUMBER),
          prNumber: asNumber(pick(env.CHANGE_ID)),
          trigger: pick(env.CHANGE_ID) ? 'pull_request' : 'push',
        }
      : null,
]

export const detectCi = (env: Env): CiSignals | null => {
  for (const detect of DETECTORS) {
    const signals = detect(env)
    if (signals) return signals
  }
  return null
}

export const resolveRunContext = (
  env: Record<string, string | undefined>,
  shard?: ShardInfo | null,
): RunContext => {
  const ci = detectCi(env)
  const explicitShard = shard && shard.total > 1 ? shard : null

  return {
    project: pick(env.FLAKEMETRY_PROJECT) ?? 'local/project',
    commitSha: ci?.commitSha ?? pick(env.FLAKEMETRY_COMMIT_SHA) ?? '0000000',
    branch: ci?.branch ?? pick(env.FLAKEMETRY_BRANCH) ?? 'local',
    ciProvider: ci?.provider ?? 'local',
    trigger: ci?.trigger ?? 'manual',
    ciRunId: ci?.runId ?? null,
    prNumber: ci?.prNumber ?? null,
    shardIndex: explicitShard
      ? explicitShard.current
      : (ci?.shardTotal ?? 0) > 1
        ? (ci?.shardIndex ?? null)
        : null,
    shardTotal: explicitShard
      ? explicitShard.total
      : (ci?.shardTotal ?? 0) > 1
        ? (ci?.shardTotal ?? null)
        : null,
  }
}

export const buildIdempotencyKey = (
  context: RunContext,
  env: Record<string, string | undefined>,
): string => {
  const explicit = env.FLAKEMETRY_IDEMPOTENCY_KEY
  if (explicit) return explicit
  if (context.ciRunId) {
    // Fall back to the GitHub variable so a hand-built context keeps working when
    // detection finds nothing to go on.
    const attempt = detectCi(env)?.attempt ?? pick(env.GITHUB_RUN_ATTEMPT) ?? '1'
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
