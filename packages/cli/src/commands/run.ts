import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'

import type { CommandModule } from '../registry'
import { DEFAULT_RESULTS_FILE, runUpload, type UploadOutcome } from './upload'

export interface WrappedCommand {
  command: string
  args: string[]
}

/**
 * `flakemetry run -- pnpm test` and `flakemetry run pnpm test` both read naturally, so both
 * are accepted; everything after the first `--` is the command.
 */
export const parseWrappedCommand = (argv: readonly string[]): WrappedCommand | null => {
  const separator = argv.indexOf('--')
  const parts = (separator === -1 ? argv : argv.slice(separator + 1)).filter(
    (part) => part.length > 0,
  )
  const [command, ...args] = parts
  return command ? { command, args } : null
}

export type Spawner = (command: string, args: string[]) => Promise<number>

const defaultSpawner: Spawner = (command, args) =>
  new Promise((resolve) => {
    const child = spawn(command, args, { stdio: 'inherit', shell: false })
    child.on('error', () => resolve(127))
    child.on('close', (code, signal) => resolve(signal ? 1 : (code ?? 1)))
  })

export interface RunResult {
  exitCode: number
  upload: UploadOutcome | null
}

export interface RunParams {
  command: WrappedCommand
  file?: string
  endpoint?: string | null
  token?: string | null
  spawner?: Spawner
  upload?: (file: string) => Promise<UploadOutcome>
  fileExists?: (path: string) => boolean
  onNotice?: (message: string) => void
}

/**
 * The wrapped command's exit code is the exit code, always. A test suite that failed must
 * still fail, and — the part that actually matters — an upload that fails must never turn a
 * green build red. Results are most worth having exactly when the suite failed, so the upload
 * runs regardless of the outcome and is only ever allowed to warn.
 */
export const runWrapped = async (params: RunParams): Promise<RunResult> => {
  const spawner = params.spawner ?? defaultSpawner
  const notice = params.onNotice ?? (() => undefined)
  const file = params.file ?? DEFAULT_RESULTS_FILE

  const exitCode = await spawner(params.command.command, params.command.args)

  // A missing results file is a failure for `upload`, where a specific file was named, and
  // merely nothing to do here — wrapping a suite whose reporter is not configured yet is
  // ordinary, and calling it a failure on every run trains people to ignore the output.
  const exists = params.fileExists ?? existsSync
  if (!exists(file)) {
    const skipped: UploadOutcome = { status: 'skipped', reason: `no results file at ${file}` }
    notice(`flakemetry: nothing to upload — ${skipped.reason}`)
    return { exitCode, upload: skipped }
  }

  let upload: UploadOutcome | null = null
  try {
    upload =
      params.upload !== undefined
        ? await params.upload(file)
        : await runUpload({ file, endpoint: params.endpoint, token: params.token })
  } catch (error) {
    upload = { status: 'failed', reason: error instanceof Error ? error.message : String(error) }
  }

  if (upload.status === 'failed') {
    notice(`flakemetry: results were not uploaded — ${upload.reason ?? 'unknown reason'}`)
  }
  if (upload.status === 'skipped') {
    notice(`flakemetry: nothing uploaded — ${upload.reason ?? 'no results file'}`)
  }

  return { exitCode, upload }
}

export const runCommand: CommandModule = {
  name: 'run',
  description: 'Run a test command and upload its results afterwards',
  register: (program, context) => {
    program
      .command('run')
      .description('Wrap a test command: run it, upload the results, exit with its code')
      .argument('<command...>', 'the command to run, optionally after --')
      .option('--file <path>', 'results file the reporter wrote', DEFAULT_RESULTS_FILE)
      .option('--endpoint <url>', 'ingestion endpoint (overrides FLAKEMETRY_ENDPOINT)')
      .option('--token <token>', 'ingest token (overrides FLAKEMETRY_TOKEN)')
      .allowUnknownOption()
      .action(
        async (parts: string[], options: { file?: string; endpoint?: string; token?: string }) => {
          const command = parseWrappedCommand(parts)
          if (!command) {
            process.stderr.write('flakemetry: nothing to run\n')
            process.exitCode = 1
            return
          }

          const result = await runWrapped({
            command,
            file: options.file,
            endpoint:
              options.endpoint ??
              context.env.FLAKEMETRY_ENDPOINT ??
              context.resolveConfig().config.endpoint,
            token: options.token ?? context.token,
            onNotice: (message) => process.stderr.write(`${message}\n`),
          })

          if (result.upload?.status === 'uploaded') {
            process.stdout.write(
              `flakemetry: uploaded ${result.upload.acceptedExecutions ?? 0} execution(s)\n`,
            )
          }

          process.exitCode = result.exitCode
        },
      )
  },
}
