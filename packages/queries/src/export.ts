import type { PrismaClient } from '@flakemetry/db'

export type ExportKeyType = 'uuid' | 'text' | 'date'

export interface ExportKey {
  name: string
  type: ExportKeyType
}

export interface ExportDataset {
  name: string
  table: string
  filterColumn: string
  keys: ExportKey[]
  omit?: string[]
  cleared?: string[]
}

const uuid = (name: string): ExportKey => ({ name, type: 'uuid' })
const text = (name: string): ExportKey => ({ name, type: 'text' })
const date = (name: string): ExportKey => ({ name, type: 'date' })

const byId: ExportKey[] = [uuid('id')]

/**
 * The datasets are data so the export, the coverage guard and the documentation all read
 * from one list. `omit` is not cosmetic: a token hash is an offline dictionary attack away
 * from being a token, and a webhook secret is a live forging key — an export is available
 * to anyone holding a read credential, so shipping either would turn "download my data"
 * into "take the project's keys".
 *
 * `cleared` names columns that read like credentials and are not. The coverage guard
 * insists every credential-shaped column be one or the other, so a column added later
 * cannot join the archive without someone having looked at it.
 */
export const EXPORT_DATASETS: readonly ExportDataset[] = [
  {
    name: 'project',
    table: 'project',
    filterColumn: 'id',
    keys: byId,
    omit: ['badge_token'],
  },
  {
    name: 'project_policy',
    table: 'project_policy',
    filterColumn: 'project_id',
    keys: [uuid('project_id')],
  },
  { name: 'policy_change', table: 'policy_change', filterColumn: 'project_id', keys: byId },
  {
    name: 'notification_channel',
    table: 'notification_channel',
    filterColumn: 'project_id',
    keys: byId,
    omit: ['secret'],
  },
  {
    name: 'ingest_token',
    table: 'ingest_token',
    filterColumn: 'project_id',
    keys: byId,
    omit: ['token_hash'],
  },
  { name: 'test_identity', table: 'test_identity', filterColumn: 'project_id', keys: byId },
  { name: 'run', table: 'run', filterColumn: 'project_id', keys: byId },
  { name: 'test_execution', table: 'test_execution', filterColumn: 'project_id', keys: byId },
  {
    name: 'flaky_score',
    table: 'flaky_score',
    filterColumn: 'project_id',
    keys: [uuid('test_identity_id')],
  },
  { name: 'error_cluster', table: 'error_cluster', filterColumn: 'project_id', keys: byId },
  {
    name: 'error_signature',
    table: 'error_signature',
    filterColumn: 'project_id',
    keys: byId,
    cleared: ['tokens'],
  },
  {
    name: 'rca_report',
    table: 'rca_report',
    filterColumn: 'project_id',
    keys: byId,
    cleared: ['token_cost'],
  },
  { name: 'rca_feedback', table: 'rca_feedback', filterColumn: 'project_id', keys: byId },
  {
    name: 'daily_test_stats',
    table: 'daily_test_stats',
    filterColumn: 'project_id',
    keys: [uuid('test_identity_id'), date('day')],
  },
  {
    name: 'suite_daily',
    table: 'suite_daily',
    filterColumn: 'project_id',
    keys: [text('suite'), date('day')],
  },
  {
    name: 'flaky_trends',
    table: 'flaky_trends',
    filterColumn: 'project_id',
    keys: [date('day')],
  },
  { name: 'test_health_event', table: 'test_health_event', filterColumn: 'project_id', keys: byId },
  { name: 'identity_stitch', table: 'identity_stitch', filterColumn: 'project_id', keys: byId },
  { name: 'identity_change', table: 'identity_change', filterColumn: 'project_id', keys: byId },
  { name: 'identity_merge', table: 'identity_merge', filterColumn: 'project_id', keys: byId },
  { name: 'tracker_issue', table: 'tracker_issue', filterColumn: 'project_id', keys: byId },
]

/**
 * Tables that carry a project id and are still left out, each for a stated reason. The
 * coverage guard forces every project-scoped table to appear here or above, so a table
 * added later cannot quietly fall out of the export.
 */
export const EXPORT_EXCLUDED: Readonly<Record<string, string>> = {
  ingestion_job:
    'the ingestion work queue: its payloads are the runs and executions already exported, so including them would double the archive',
  data_request:
    'the export and erasure audit log itself, which is about the tenant rather than part of it',
}

const IDENTIFIER = /^[a-z_][a-z0-9_]*$/

/**
 * Table and column names cannot be bound as parameters, so they are concatenated into the
 * query. They come from the table above rather than from a request, but a name that reaches
 * SQL by concatenation is checked before it gets there regardless.
 */
const identifier = (value: string): string => {
  if (!IDENTIFIER.test(value)) throw new Error(`unsafe identifier: ${value}`)
  return `"${value}"`
}

const cursorValue = (key: ExportKey, raw: unknown): string =>
  key.type === 'date' && raw instanceof Date ? raw.toISOString().slice(0, 10) : String(raw)

export const DEFAULT_PAGE_SIZE = 500

export type ExportRow = Record<string, unknown>

export const pageQuery = (
  dataset: ExportDataset,
  cursor: readonly string[] | null,
  pageSize: number,
): string => {
  const keys = dataset.keys.map((key) => identifier(key.name)).join(', ')
  const where = [`${identifier(dataset.filterColumn)} = $1::uuid`]
  if (cursor) {
    const placeholders = dataset.keys.map((key, index) => `$${index + 2}::${key.type}`).join(', ')
    const left = dataset.keys.length === 1 ? keys : `(${keys})`
    const right = dataset.keys.length === 1 ? placeholders : `(${placeholders})`
    where.push(`${left} > ${right}`)
  }
  return [
    `SELECT * FROM ${identifier(dataset.table)}`,
    `WHERE ${where.join(' AND ')}`,
    `ORDER BY ${keys}`,
    `LIMIT ${Math.max(1, Math.trunc(pageSize))}`,
  ].join(' ')
}

const strip = (row: ExportRow, omit: readonly string[] | undefined): ExportRow => {
  if (!omit || omit.length === 0) return row
  const out: ExportRow = {}
  for (const [column, value] of Object.entries(row)) {
    if (!omit.includes(column)) out[column] = value
  }
  return out
}

export const streamDataset = async function* (
  prisma: PrismaClient,
  dataset: ExportDataset,
  projectId: string,
  pageSize: number = DEFAULT_PAGE_SIZE,
): AsyncGenerator<ExportRow> {
  let cursor: string[] | null = null

  for (;;) {
    const sql = pageQuery(dataset, cursor, pageSize)
    const rows = await prisma.$queryRawUnsafe<ExportRow[]>(sql, projectId, ...(cursor ?? []))
    if (rows.length === 0) return

    for (const row of rows) yield strip(row, dataset.omit)

    if (rows.length < pageSize) return
    const last = rows[rows.length - 1] as ExportRow
    cursor = dataset.keys.map((key) => cursorValue(key, last[key.name]))
  }
}

export interface ArtifactLister {
  list(prefix: string): Promise<{ key: string; size: number; lastModified: Date }[]>
}

export interface ExportSummary {
  rows: number
  artifacts: number
  counts: Record<string, number>
}

export interface ExportOptions {
  projectId: string
  exportedAt: Date
  artifacts?: { prefix: string; store: ArtifactLister } | null
  pageSize?: number
  datasets?: readonly ExportDataset[]
  onComplete?: (summary: ExportSummary) => void | Promise<void>
}

export type ExportLine =
  | { type: 'manifest'; version: number; projectId: string; exportedAt: string; datasets: string[] }
  | { type: 'row'; dataset: string; data: ExportRow }
  | { type: 'artifact'; key: string; size: number; lastModified: string }
  | { type: 'summary'; rows: number; artifacts: number; counts: Record<string, number> }

export const MANIFEST_VERSION = 1

const line = (value: ExportLine): string =>
  `${JSON.stringify(value, (_key, raw: unknown) =>
    typeof raw === 'bigint' ? Number(raw) : raw,
  )}\n`

/**
 * NDJSON so the archive streams: a project with a million executions never has to fit in
 * memory on either side. The trailing summary is what makes a truncated download
 * detectable — without it a stream that died halfway looks exactly like a small project.
 */
export const streamProjectExport = async function* (
  prisma: PrismaClient,
  options: ExportOptions,
): AsyncGenerator<string> {
  const datasets = options.datasets ?? EXPORT_DATASETS
  const counts: Record<string, number> = {}
  let rows = 0

  yield line({
    type: 'manifest',
    version: MANIFEST_VERSION,
    projectId: options.projectId,
    exportedAt: options.exportedAt.toISOString(),
    datasets: datasets.map((dataset) => dataset.name),
  })

  for (const dataset of datasets) {
    let count = 0
    for await (const row of streamDataset(prisma, dataset, options.projectId, options.pageSize)) {
      count += 1
      rows += 1
      yield line({ type: 'row', dataset: dataset.name, data: row })
    }
    counts[dataset.name] = count
  }

  let artifacts = 0
  if (options.artifacts) {
    const objects = await options.artifacts.store.list(options.artifacts.prefix)
    artifacts = objects.length
    for (const object of objects) {
      yield line({
        type: 'artifact',
        key: object.key,
        size: object.size,
        lastModified: object.lastModified.toISOString(),
      })
    }
  }

  // Awaited, and before the final yield rather than after: a consumer that stops reading
  // never resumes the generator, so an audit record left open would be indistinguishable
  // from an export that died.
  await options.onComplete?.({ rows, artifacts, counts })
  yield line({ type: 'summary', rows, artifacts, counts })
}

export const exportFilename = (projectSlug: string, exportedAt: Date): string =>
  `flakemetry-${projectSlug}-${exportedAt.toISOString().slice(0, 10)}.ndjson.gz`
