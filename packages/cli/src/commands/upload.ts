import { existsSync, readFileSync } from 'node:fs'

import { ingestRunBatchSchema } from '@flakemetry/contracts'
import { IngestClient } from '@flakemetry/sdk'

import type { CommandModule } from '../registry'

export const DEFAULT_RESULTS_FILE = 'flakemetry-results.json'

export type UploadStatus = 'uploaded' | 'skipped' | 'failed'

export interface UploadOutcome {
  status: UploadStatus
  reason?: string
  receiptId?: string
  acceptedExecutions?: number
}

export interface UploadParams {
  file: string
  endpoint?: string | null
  token?: string | null
  fetchImpl?: typeof fetch
  readFile?: (path: string) => string
  fileExists?: (path: string) => boolean
}

export const runUpload = async (params: UploadParams): Promise<UploadOutcome> => {
  const readFile = params.readFile ?? ((path: string) => readFileSync(path, 'utf8'))
  const fileExists = params.fileExists ?? existsSync

  if (!params.endpoint || !params.token)
    return {
      status: 'skipped',
      reason: 'endpoint and token are required (set FLAKEMETRY_ENDPOINT and FLAKEMETRY_TOKEN)',
    }

  if (!fileExists(params.file))
    return { status: 'failed', reason: `results file not found: ${params.file}` }

  let raw: unknown
  try {
    raw = JSON.parse(readFile(params.file))
  } catch (error) {
    return {
      status: 'failed',
      reason: `could not parse ${params.file}: ${error instanceof Error ? error.message : String(error)}`,
    }
  }

  const parsed = ingestRunBatchSchema.safeParse(raw)
  if (!parsed.success)
    return {
      status: 'failed',
      reason: `invalid results file: ${parsed.error.issues[0]?.message ?? 'schema mismatch'}`,
    }

  const client = new IngestClient({
    endpoint: params.endpoint,
    token: params.token,
    fetchImpl: params.fetchImpl,
  })
  const result = await client.send(parsed.data)
  if (!result.ok)
    return {
      status: 'failed',
      reason: result.error ?? `ingestion returned status ${result.status ?? 'unknown'}`,
    }

  return {
    status: 'uploaded',
    receiptId: result.ack?.receiptId,
    acceptedExecutions: result.ack?.acceptedExecutions,
  }
}

export const uploadCommand: CommandModule = {
  name: 'upload',
  description: 'Upload a recorded test run to the ingestion API',
  register: (program, context) => {
    program
      .command('upload')
      .description('Send a Flakemetry results file to the ingestion API')
      .argument('[file]', 'results file written by the reporter', DEFAULT_RESULTS_FILE)
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
          const outcome = await runUpload({ file, endpoint, token })

          if (outcome.status === 'uploaded') {
            process.stdout.write(
              `flakemetry: uploaded ${outcome.acceptedExecutions ?? 0} execution(s) (receipt ${outcome.receiptId ?? 'n/a'})\n`,
            )
            return
          }

          process.stderr.write(`flakemetry: upload ${outcome.status} — ${outcome.reason}\n`)
          if (options.failOnError) process.exitCode = 1
        },
      )
  },
}
