import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'

import { type AllureResult, parseAllureResults } from '@flakemetry/contracts'

import type { CommandModule } from '../registry'
import { uploadParsedRun } from './junit'
import { describeUpload, type UploadOutcome } from './upload'

export const DEFAULT_ALLURE_DIRECTORY = 'allure-results'

export const listAllureResultFiles = (directory: string): string[] => {
  const found: string[] = []
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const full = join(directory, entry.name)
    if (entry.isDirectory()) found.push(...listAllureResultFiles(full))
    else if (entry.name.endsWith('-result.json')) found.push(full)
  }
  return found.sort()
}

export interface AllureUploadParams {
  directory: string
  endpoint?: string | null
  token?: string | null
  env: Record<string, string | undefined>
  fetchImpl?: typeof fetch
}

export const runAllureUpload = async (params: AllureUploadParams): Promise<UploadOutcome> => {
  if (!params.endpoint || !params.token) {
    return {
      status: 'skipped',
      reason: 'endpoint and token are required (set FLAKEMETRY_ENDPOINT and FLAKEMETRY_TOKEN)',
    }
  }
  if (!existsSync(params.directory) || !statSync(params.directory).isDirectory()) {
    return { status: 'failed', reason: `allure results directory not found: ${params.directory}` }
  }

  const results: AllureResult[] = []
  for (const file of listAllureResultFiles(params.directory)) {
    try {
      results.push(JSON.parse(readFileSync(file, 'utf8')) as AllureResult)
    } catch (error) {
      return {
        status: 'failed',
        reason: `could not parse ${file}: ${error instanceof Error ? error.message : String(error)}`,
      }
    }
  }

  const run = parseAllureResults(results)
  if (run.executions.length === 0) {
    return { status: 'skipped', reason: `no test results found in ${params.directory}` }
  }

  return uploadParsedRun({
    run,
    endpoint: params.endpoint,
    token: params.token,
    env: params.env,
    fetchImpl: params.fetchImpl,
  })
}

export const allureCommand: CommandModule = {
  name: 'allure',
  description: 'Ingest Allure results, with every attempt of a retried test',
  register: (program, context) => {
    program
      .command('allure')
      .description('Upload a directory of Allure results, keeping retries')
      .argument('[directory]', 'Allure results directory', DEFAULT_ALLURE_DIRECTORY)
      .option('--endpoint <url>', 'ingestion endpoint (overrides FLAKEMETRY_ENDPOINT)')
      .option('--token <token>', 'ingest token (overrides FLAKEMETRY_TOKEN)')
      .option('--fail-on-error', 'exit with a non-zero code if the upload fails', false)
      .action(
        async (
          directory: string,
          options: { endpoint?: string; token?: string; failOnError?: boolean },
        ) => {
          const endpoint =
            options.endpoint ??
            context.env.FLAKEMETRY_ENDPOINT ??
            context.resolveConfig().config.endpoint
          const token = options.token ?? context.token
          const outcome = await runAllureUpload({ directory, endpoint, token, env: context.env })

          if (outcome.status === 'uploaded') {
            process.stdout.write(describeUpload(outcome))
            return
          }

          process.stderr.write(`flakemetry: allure ${outcome.status} — ${outcome.reason}\n`)
          if (options.failOnError) process.exitCode = 1
        },
      )
  },
}
