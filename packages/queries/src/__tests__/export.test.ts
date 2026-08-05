import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import type { PrismaClient } from '@flakemetry/db'
import { describe, expect, it } from 'vitest'

import {
  EXPORT_DATASETS,
  EXPORT_EXCLUDED,
  type ExportDataset,
  exportFilename,
  type ExportRow,
  pageQuery,
  streamProjectExport,
} from '../export'

const PROJECT = '11111111-1111-1111-1111-111111111111'

const fakePrisma = (rowsByTable: Record<string, ExportRow[]>): PrismaClient =>
  ({
    $queryRawUnsafe: async (sql: string, ...params: unknown[]) => {
      const table = /FROM "([a-z_]+)"/.exec(sql)?.[1] ?? ''
      const limit = Number(/LIMIT (\d+)/.exec(sql)?.[1] ?? 0)
      const cursor = params[1] as string | undefined
      const all = rowsByTable[table] ?? []
      const after = cursor ? all.filter((row) => String(row.id) > cursor) : all
      return after.slice(0, limit)
    },
  }) as unknown as PrismaClient

const dataset = (over: Partial<ExportDataset> = {}): ExportDataset => ({
  name: 'run',
  table: 'run',
  filterColumn: 'project_id',
  keys: [{ name: 'id', type: 'uuid' }],
  ...over,
})

const collect = async (stream: AsyncGenerator<string>): Promise<Record<string, unknown>[]> => {
  const lines: Record<string, unknown>[] = []
  for await (const chunk of stream) {
    for (const raw of chunk.split('\n').filter((part) => part.length > 0)) {
      lines.push(JSON.parse(raw) as Record<string, unknown>)
    }
  }
  return lines
}

describe('pageQuery', () => {
  it('filters by the scope column and orders by the key', () => {
    const sql = pageQuery(dataset(), null, 100)

    expect(sql).toContain('WHERE "project_id" = $1::uuid')
    expect(sql).toContain('ORDER BY "id"')
    expect(sql).toContain('LIMIT 100')
  })

  it('pages with a keyset rather than an offset', () => {
    const sql = pageQuery(dataset(), ['a'], 100)

    // Offset paging re-reads everything already sent; on a project with a million
    // executions the last page would scan the whole table.
    expect(sql).not.toContain('OFFSET')
    expect(sql).toContain('"id" > $2::uuid')
  })

  it('compares composite keys as a row so the second column is not lost', () => {
    const sql = pageQuery(
      dataset({
        table: 'daily_test_stats',
        keys: [
          { name: 'test_identity_id', type: 'uuid' },
          { name: 'day', type: 'date' },
        ],
      }),
      ['a', '2026-01-01'],
      50,
    )

    expect(sql).toContain('("test_identity_id", "day") > ($2::uuid, $3::date)')
  })

  it('refuses an identifier that is not one', () => {
    expect(() => pageQuery(dataset({ table: 'run"; DROP TABLE run; --' }), null, 10)).toThrow(
      /unsafe identifier/,
    )
  })

  it('bounds the page size to a whole number', () => {
    expect(pageQuery(dataset(), null, 12.7)).toContain('LIMIT 12')
    expect(pageQuery(dataset(), null, 0)).toContain('LIMIT 1')
  })
})

describe('streamProjectExport', () => {
  const exportedAt = new Date('2026-08-05T10:00:00Z')

  it('opens with a manifest and closes with a summary', async () => {
    const prisma = fakePrisma({ run: [{ id: 'a' }, { id: 'b' }] })

    const lines = await collect(
      streamProjectExport(prisma, {
        projectId: PROJECT,
        exportedAt,
        datasets: [dataset()],
      }),
    )

    expect(lines[0]).toMatchObject({ type: 'manifest', version: 1, projectId: PROJECT })
    // A gzip stream cut off halfway looks exactly like a small project unless the archive
    // says how much it should contain.
    expect(lines.at(-1)).toMatchObject({ type: 'summary', rows: 2, counts: { run: 2 } })
  })

  it('pages through a dataset larger than one page without repeating or dropping a row', async () => {
    const prisma = fakePrisma({ run: [{ id: 'a' }, { id: 'b' }, { id: 'c' }, { id: 'd' }] })

    const lines = await collect(
      streamProjectExport(prisma, {
        projectId: PROJECT,
        exportedAt,
        datasets: [dataset()],
        pageSize: 2,
      }),
    )

    const ids = lines
      .filter((line) => line.type === 'row')
      .map((line) => (line.data as ExportRow).id)
    expect(ids).toEqual(['a', 'b', 'c', 'd'])
  })

  it('never writes an omitted column', async () => {
    const prisma = fakePrisma({
      notification_channel: [{ id: 'a', kind: 'webhook', secret: 'whsec_live' }],
    })

    const lines = await collect(
      streamProjectExport(prisma, {
        projectId: PROJECT,
        exportedAt,
        datasets: [
          dataset({
            name: 'notification_channel',
            table: 'notification_channel',
            omit: ['secret'],
          }),
        ],
      }),
    )

    expect(JSON.stringify(lines)).not.toContain('whsec_live')
    expect(lines[1]).toMatchObject({ type: 'row', data: { kind: 'webhook' } })
  })

  it('inventories the artifacts alongside the rows', async () => {
    const prisma = fakePrisma({ run: [] })
    const store = {
      list: async () => [
        { key: 'org/o/proj/p/run/1/0/shot.png', size: 12, lastModified: exportedAt },
      ],
    }

    const lines = await collect(
      streamProjectExport(prisma, {
        projectId: PROJECT,
        exportedAt,
        datasets: [dataset()],
        artifacts: { prefix: 'org/o/proj/p/', store },
      }),
    )

    expect(lines.some((line) => line.type === 'artifact')).toBe(true)
    expect(lines.at(-1)).toMatchObject({ artifacts: 1 })
  })
})

describe('exportFilename', () => {
  it('names the archive after the project and the day', () => {
    expect(exportFilename('web', new Date('2026-08-05T10:00:00Z'))).toBe(
      'flakemetry-web-2026-08-05.ndjson.gz',
    )
  })
})

interface SchemaModel {
  name: string
  table: string
  columns: string[]
}

const schemaModels = (): SchemaModel[] => {
  const source = readFileSync(
    resolve(dirname(fileURLToPath(import.meta.url)), '../../../db/prisma/schema.prisma'),
    'utf8',
  )

  return [...source.matchAll(/^model\s+(\w+)\s*\{([\s\S]*?)^\}/gm)].map((match) => {
    const [, name = '', body = ''] = match
    const table = /@@map\("([^"]+)"\)/.exec(body)?.[1] ?? name
    const columns = [...body.matchAll(/^\s+(\w+)\s+\S+[^\n]*$/gm)]
      .filter((field) => !(field[0] ?? '').trimStart().startsWith('@@'))
      .map((field) => /@map\("([^"]+)"\)/.exec(field[0] ?? '')?.[1] ?? field[1] ?? '')
    return { name, table, columns }
  })
}

const SENSITIVE = /secret|token|password|credential/

describe('export coverage', () => {
  const models = schemaModels()

  it('reads the schema it is meant to be checking', () => {
    // Guard the guard: were the parse to stop matching, every check below would pass on an
    // empty list and say nothing at all.
    expect(models.length).toBeGreaterThan(20)
    expect(models.map((model) => model.table)).toContain('test_execution')
    expect(models.find((model) => model.table === 'ingest_token')?.columns).toContain('token_hash')
  })

  it('exports or explicitly excludes every project-scoped table', () => {
    const exported = new Set(EXPORT_DATASETS.map((entry) => entry.table))
    const missing = models
      .filter((model) => model.columns.includes('project_id'))
      .map((model) => model.table)
      .filter((table) => !exported.has(table) && !(table in EXPORT_EXCLUDED))

    expect(missing, 'add these to EXPORT_DATASETS, or to EXPORT_EXCLUDED with the reason').toEqual(
      [],
    )
  })

  it('classifies every credential-shaped column it exports', () => {
    const unreviewed: string[] = []
    for (const entry of EXPORT_DATASETS) {
      const model = models.find((candidate) => candidate.table === entry.table)
      for (const column of model?.columns ?? []) {
        const decided = [...(entry.omit ?? []), ...(entry.cleared ?? [])].includes(column)
        if (SENSITIVE.test(column) && !decided) unreviewed.push(`${entry.table}.${column}`)
      }
    }

    // An export is served to anyone holding a read credential. A token hash or a webhook
    // signing secret in the archive turns "download my data" into "take the project's keys".
    expect(unreviewed, 'add each column to the dataset omit or cleared list').toEqual([])
  })

  it('still trips on a credential column nobody classified', () => {
    // Guard the guard: the check above passes because every such column was decided, not
    // because it stopped looking.
    const naked = EXPORT_DATASETS.map((entry) =>
      entry.table === 'ingest_token' ? { ...entry, omit: [] } : entry,
    )
    const unreviewed = naked.flatMap((entry) =>
      (models.find((candidate) => candidate.table === entry.table)?.columns ?? [])
        .filter(
          (column) =>
            SENSITIVE.test(column) &&
            ![...(entry.omit ?? []), ...(entry.cleared ?? [])].includes(column),
        )
        .map((column) => `${entry.table}.${column}`),
    )

    expect(unreviewed).toContain('ingest_token.token_hash')
  })

  it('carries an org id on every project-scoped table', () => {
    // Erasing a workspace verifies itself by counting rows with that org id. A table
    // scoped only by project would not be counted, and its rows would survive unnoticed.
    const orphans = models
      .filter((model) => model.columns.includes('project_id') && model.table !== 'data_request')
      .filter((model) => !model.columns.includes('org_id'))
      .map((model) => model.table)

    expect(orphans).toEqual([])
  })
})
