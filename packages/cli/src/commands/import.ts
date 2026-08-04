import { createHash } from 'node:crypto'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'

import { type IngestResource, junitToIngestBatch, parseJunitXml } from '@flakemetry/contracts'
import { IngestClient } from '@flakemetry/sdk'

import type { CommandModule } from '../registry'

export interface HistoricalFile {
  path: string
  content: string
  modifiedAt: Date
}

export interface ManifestEntry {
  commitSha?: string
  branch?: string
  startedAt?: string
}

export type ImportManifest = Record<string, ManifestEntry>

export interface PlannedImport {
  path: string
  idempotencyKey: string
  commitSha: string
  branch: string
  startedAt: Date
  executionCount: number
}

export interface SkippedImport {
  path: string
  reason: string
}

export interface ImportPlan {
  runs: PlannedImport[]
  skipped: SkippedImport[]
}

const digest = (value: string): string => createHash('sha256').update(value).digest('hex')

/**
 * A JUnit report carries no commit. Deriving one from the report's own bytes keeps every
 * imported run distinct and stable across re-runs, which matters because scoring reads
 * "same commit, different result" as a flakiness signal — reusing one sha across months
 * of history would manufacture that signal everywhere.
 */
export const syntheticCommitSha = (content: string): string => digest(content).slice(0, 40)

/**
 * Deterministic in the file's identity and contents, so re-running an interrupted import
 * re-sends the same keys and the server deduplicates them instead of doubling the history.
 */
export const importIdempotencyKey = (path: string, content: string): string =>
  `junit-import-${digest(`${path}\n${content}`).slice(0, 32)}`

const parseTimestamp = (value: string | undefined): Date | null => {
  if (!value) return null
  const parsed = new Date(value)
  return Number.isNaN(parsed.getTime()) ? null : parsed
}

export const planHistoricalImport = (
  files: readonly HistoricalFile[],
  manifest: ImportManifest = {},
  defaultBranch = 'main',
): ImportPlan => {
  const runs: PlannedImport[] = []
  const skipped: SkippedImport[] = []

  for (const file of files) {
    const entry = manifest[file.path] ?? {}
    let parsed
    try {
      parsed = parseJunitXml(file.content)
    } catch (error) {
      skipped.push({
        path: file.path,
        reason: `unreadable: ${error instanceof Error ? error.message : String(error)}`,
      })
      continue
    }
    if (parsed.executions.length === 0) {
      skipped.push({ path: file.path, reason: 'no test cases' })
      continue
    }

    const startedAt =
      parseTimestamp(entry.startedAt) ??
      parseTimestamp(parsed.startedAt ?? undefined) ??
      file.modifiedAt

    runs.push({
      path: file.path,
      idempotencyKey: importIdempotencyKey(file.path, file.content),
      commitSha: entry.commitSha ?? syntheticCommitSha(file.content),
      branch: entry.branch ?? defaultBranch,
      startedAt,
      executionCount: parsed.executions.length,
    })
  }

  // Oldest first. The worker scores incrementally and stamps first-seen dates as it goes,
  // so importing newest-first would date every test identity to the end of its own history.
  runs.sort((left, right) => left.startedAt.getTime() - right.startedAt.getTime())

  return { runs, skipped }
}

export const collectJunitFiles = (
  directory: string,
  reader: { list: (dir: string) => string[]; read: (path: string) => HistoricalFile },
): HistoricalFile[] => reader.list(directory).map((path) => reader.read(path))

export const listXmlFiles = (directory: string): string[] => {
  const found: string[] = []
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name)
      if (entry.isDirectory()) walk(full)
      else if (entry.name.toLowerCase().endsWith('.xml')) found.push(full)
    }
  }
  walk(directory)
  return found.sort()
}

export const readHistoricalFile = (path: string): HistoricalFile => ({
  path,
  content: readFileSync(path, 'utf8'),
  modifiedAt: statSync(path).mtime,
})

export interface ImportSummary {
  imported: number
  failed: number
  skipped: number
  executions: number
}

export interface RunImportParams {
  plan: ImportPlan
  endpoint: string
  token: string
  ciProvider?: IngestResource['ciProvider']
  fetchImpl?: typeof fetch
  onProgress?: (done: number, total: number, run: PlannedImport) => void
  onFailure?: (run: PlannedImport, reason: string) => void
}

export const runHistoricalImport = async (params: RunImportParams): Promise<ImportSummary> => {
  const client = new IngestClient({
    endpoint: params.endpoint,
    token: params.token,
    fetchImpl: params.fetchImpl,
  })

  const summary: ImportSummary = {
    imported: 0,
    failed: 0,
    skipped: params.plan.skipped.length,
    executions: 0,
  }

  let done = 0
  for (const run of params.plan.runs) {
    const resource: IngestResource = {
      ciProvider: params.ciProvider ?? 'local',
      commitSha: run.commitSha,
      branch: run.branch,
      trigger: 'manual',
    }
    const batch = junitToIngestBatch(parseJunitXml(readFileSync(run.path, 'utf8')), {
      idempotencyKey: run.idempotencyKey,
      resource,
      startedAt: run.startedAt,
    })

    const result = await client.send(batch)
    done += 1
    if (result.ok) {
      summary.imported += 1
      summary.executions += run.executionCount
    } else {
      summary.failed += 1
      params.onFailure?.(run, result.error ?? `status ${result.status ?? 'unknown'}`)
    }
    params.onProgress?.(done, params.plan.runs.length, run)
  }

  return summary
}

export const importCommand: CommandModule = {
  name: 'import',
  description: 'Import a directory of JUnit XML reports as historical runs',
  register: (program, context) => {
    program
      .command('import')
      .description('Seed history from an archive of JUnit XML reports')
      .argument('<directory>', 'directory to search for .xml reports')
      .option('--endpoint <url>', 'ingestion endpoint (overrides FLAKEMETRY_ENDPOINT)')
      .option('--token <token>', 'ingest token (overrides FLAKEMETRY_TOKEN)')
      .option('--manifest <file>', 'JSON map of report path to { commitSha, branch, startedAt }')
      .option('--branch <name>', 'branch to record when the manifest does not say', 'main')
      .option('--dry-run', 'show what would be imported without sending anything', false)
      .action(
        async (
          directory: string,
          options: {
            endpoint?: string
            token?: string
            manifest?: string
            branch?: string
            dryRun?: boolean
          },
        ) => {
          const files = listXmlFiles(directory).map(readHistoricalFile)
          if (files.length === 0) {
            process.stderr.write(`flakemetry: no .xml reports under ${directory}\n`)
            process.exitCode = 1
            return
          }

          const manifest: ImportManifest = options.manifest
            ? (JSON.parse(readFileSync(options.manifest, 'utf8')) as ImportManifest)
            : {}
          const plan = planHistoricalImport(files, manifest, options.branch ?? 'main')

          for (const skip of plan.skipped) {
            process.stderr.write(`flakemetry: skipped ${skip.path} — ${skip.reason}\n`)
          }

          if (plan.runs.length === 0) {
            process.stderr.write('flakemetry: nothing to import\n')
            process.exitCode = 1
            return
          }

          const first = plan.runs[0]
          const last = plan.runs[plan.runs.length - 1]
          process.stdout.write(
            `flakemetry: ${plan.runs.length} run(s) from ${first?.startedAt.toISOString()} to ${last?.startedAt.toISOString()}\n`,
          )

          if (options.dryRun) {
            for (const run of plan.runs) {
              process.stdout.write(
                `  ${run.startedAt.toISOString()}  ${run.executionCount} test(s)  ${run.path}\n`,
              )
            }
            return
          }

          const endpoint =
            options.endpoint ??
            context.env.FLAKEMETRY_ENDPOINT ??
            context.resolveConfig().config.endpoint
          const token = options.token ?? context.token
          if (!endpoint || !token) {
            process.stderr.write(
              'flakemetry: endpoint and token are required (set FLAKEMETRY_ENDPOINT and FLAKEMETRY_TOKEN)\n',
            )
            process.exitCode = 1
            return
          }

          const summary = await runHistoricalImport({
            plan,
            endpoint,
            token,
            onProgress: (doneCount, total) => {
              process.stdout.write(`\rflakemetry: ${doneCount}/${total} run(s) sent`)
            },
            onFailure: (run, reason) => {
              process.stderr.write(`\nflakemetry: failed ${run.path} — ${reason}\n`)
            },
          })

          process.stdout.write(
            `\nflakemetry: imported ${summary.imported} run(s), ${summary.executions} execution(s)` +
              `${summary.failed > 0 ? `, ${summary.failed} failed` : ''}` +
              `${summary.skipped > 0 ? `, ${summary.skipped} skipped` : ''}\n`,
          )
          if (summary.failed > 0) process.exitCode = 1
        },
      )
  },
}
