import { existsSync, readFileSync } from 'node:fs'

import { parseJunitXml } from '@flakemetry/contracts'
import {
  buildIdempotencyKey,
  IngestClient,
  resolveRunContext,
  TestRunRecorder,
} from '@flakemetry/sdk'

import type { CommandModule } from '../registry'
import type { UploadOutcome } from './upload'

export const DEFAULT_JUNIT_FILE = 'junit.xml'

export interface JunitUploadParams {
  file: string
  endpoint?: string | null
  token?: string | null
  env: Record<string, string | undefined>
  fetchImpl?: typeof fetch
  readFile?: (path: string) => string
  fileExists?: (path: string) => boolean
}

export const runJunitUpload = async (params: JunitUploadParams): Promise<UploadOutcome> => {
  const readFile = params.readFile ?? ((path: string) => readFileSync(path, 'utf8'))
  const fileExists = params.fileExists ?? existsSync

  if (!params.endpoint || !params.token) {
    return {
      status: 'skipped',
      reason: 'endpoint and token are required (set FLAKEMETRY_ENDPOINT and FLAKEMETRY_TOKEN)',
    }
  }
  if (!fileExists(params.file)) {
    return { status: 'failed', reason: `junit file not found: ${params.file}` }
  }

  let run
  try {
    run = parseJunitXml(readFile(params.file))
  } catch (error) {
    return {
      status: 'failed',
      reason: `could not parse ${params.file}: ${error instanceof Error ? error.message : String(error)}`,
    }
  }
  if (run.executions.length === 0) {
    return { status: 'skipped', reason: `no test cases found in ${params.file}` }
  }

  const startedAt = run.startedAt ? new Date(run.startedAt) : new Date()
  const context = resolveRunContext(params.env)
  const recorder = new TestRunRecorder(context)
  recorder.startRun(startedAt)
  for (const execution of run.executions) {
    recorder.record({
      filePath: execution.filePath,
      suite: execution.suite,
      title: execution.title,
      status: execution.status,
      attempt: 1,
      startedAt,
      durationMs: execution.durationMs,
      error: execution.error ?? null,
    })
  }
  const failed = run.executions.some((execution) => execution.status === 'fail')
  recorder.finishRun(failed ? 'failed' : 'passed', new Date())

  const batch = recorder.toIngestBatch(buildIdempotencyKey(context, params.env))
  const client = new IngestClient({
    endpoint: params.endpoint,
    token: params.token,
    fetchImpl: params.fetchImpl,
  })
  const result = await client.send(batch)
  if (!result.ok) {
    return {
      status: 'failed',
      reason: result.error ?? `ingestion returned status ${result.status ?? 'unknown'}`,
    }
  }

  return {
    status: 'uploaded',
    receiptId: result.ack?.receiptId,
    acceptedExecutions: result.ack?.acceptedExecutions,
  }
}

export const junitCommand: CommandModule = {
  name: 'junit',
  description: 'Ingest a JUnit XML report (pytest, Go, Ruby, JUnit, …)',
  register: (program, context) => {
    program
      .command('junit')
      .description('Map a JUnit XML report onto Flakemetry conventions and upload it')
      .argument('[file]', 'JUnit XML report', DEFAULT_JUNIT_FILE)
      .option('--endpoint <url>', 'ingestion endpoint (overrides FLAKEMETRY_ENDPOINT)')
      .option('--token <token>', 'ingest token (overrides FLAKEMETRY_TOKEN)')
      .option('--fail-on-error', 'exit with a non-zero code if the upload fails', false)
      .action(
        async (
          file: string,
          options: { endpoint?: string; token?: string; failOnError?: boolean },
        ) => {
          const endpoint =
            options.endpoint ??
            context.env.FLAKEMETRY_ENDPOINT ??
            context.resolveConfig().config.endpoint
          const token = options.token ?? context.token
          const outcome = await runJunitUpload({ file, endpoint, token, env: context.env })

          if (outcome.status === 'uploaded') {
            process.stdout.write(
              `flakemetry: uploaded ${outcome.acceptedExecutions ?? 0} execution(s) (receipt ${outcome.receiptId ?? 'n/a'})\n`,
            )
            return
          }

          process.stderr.write(`flakemetry: junit ${outcome.status} — ${outcome.reason}\n`)
          if (options.failOnError) process.exitCode = 1
        },
      )
  },
}
