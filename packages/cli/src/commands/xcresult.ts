import { existsSync, readFileSync } from 'node:fs'

import { parseXcresultTests, type XcresultTests } from '@flakemetry/contracts'

import type { CommandModule } from '../registry'
import { uploadParsedRun } from './junit'
import { describeUpload, type UploadOutcome } from './upload'

export interface XcresultUploadParams {
  file: string
  endpoint?: string | null
  token?: string | null
  env: Record<string, string | undefined>
  fetchImpl?: typeof fetch
  readFile?: (path: string) => string
  fileExists?: (path: string) => boolean
}

export const runXcresultUpload = async (params: XcresultUploadParams): Promise<UploadOutcome> => {
  const readFile = params.readFile ?? ((path: string) => readFileSync(path, 'utf8'))
  const fileExists = params.fileExists ?? existsSync

  if (!params.endpoint || !params.token) {
    return {
      status: 'skipped',
      reason: 'endpoint and token are required (set FLAKEMETRY_ENDPOINT and FLAKEMETRY_TOKEN)',
    }
  }
  if (!fileExists(params.file)) {
    return { status: 'failed', reason: `xcresult summary not found: ${params.file}` }
  }

  let tests: XcresultTests
  try {
    tests = JSON.parse(readFile(params.file)) as XcresultTests
  } catch (error) {
    return {
      status: 'failed',
      reason: `could not parse ${params.file}: ${error instanceof Error ? error.message : String(error)}`,
    }
  }

  const run = parseXcresultTests(tests)
  if (run.executions.length === 0) {
    return { status: 'skipped', reason: `no test cases found in ${params.file}` }
  }

  return uploadParsedRun({
    run,
    endpoint: params.endpoint,
    token: params.token,
    env: params.env,
    fetchImpl: params.fetchImpl,
  })
}

export const xcresultCommand: CommandModule = {
  name: 'xcresult',
  description: 'Ingest the JSON from xcresulttool, with every repetition of a retried test',
  register: (program, context) => {
    program
      .command('xcresult')
      .description('Upload the output of `xcrun xcresulttool get test-results tests`')
      .argument('<file>', 'JSON written by xcresulttool')
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
          const outcome = await runXcresultUpload({ file, endpoint, token, env: context.env })

          if (outcome.status === 'uploaded') {
            process.stdout.write(describeUpload(outcome))
            return
          }

          process.stderr.write(`flakemetry: xcresult ${outcome.status} — ${outcome.reason}\n`)
          if (options.failOnError) process.exitCode = 1
        },
      )
  },
}
