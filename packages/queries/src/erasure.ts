import type { PrismaClient } from '@flakemetry/db'

export type ErasureScope = 'project' | 'org'

export interface ErasureTarget {
  kind: ErasureScope
  id: string
  orgId: string
  artifactPrefix: string
}

export interface ArtifactSweeper {
  list(prefix: string): Promise<{ key: string }[]>
  remove(keys: string[]): Promise<void>
}

export interface ErasureOutcome {
  rowsDeleted: number
  artifactsDeleted: number
  residue: Record<string, number>
  verified: boolean
}

/**
 * The audit log records that an erasure happened, so it has to outlive the tenant it
 * describes; counting it as residue would make every erasure report itself as incomplete.
 */
export const ERASURE_EXEMPT_TABLES: readonly string[] = ['data_request']

export const ARTIFACT_RESIDUE_KEY = 'artifacts'

const IDENTIFIER = /^[a-z_][a-z0-9_]*$/

const identifier = (value: string): string => {
  if (!IDENTIFIER.test(value)) throw new Error(`unsafe identifier: ${value}`)
  return `"${value}"`
}

export const scopeColumn = (kind: ErasureScope): string =>
  kind === 'project' ? 'project_id' : 'org_id'

/**
 * Asked of the live database rather than of a list kept in this file. A hand-maintained
 * list is right on the day it is written and wrong the first time someone adds a model —
 * and a table missing from it is a table whose rows survive an erasure silently.
 */
export const tablesWithColumn = async (prisma: PrismaClient, column: string): Promise<string[]> => {
  const rows = await prisma.$queryRaw<{ table_name: string }[]>`
    SELECT c.table_name
    FROM information_schema.columns c
    JOIN information_schema.tables t
      ON t.table_schema = c.table_schema AND t.table_name = c.table_name
    WHERE c.table_schema = current_schema()
      AND t.table_type = 'BASE TABLE'
      AND c.column_name = ${column}
    ORDER BY c.table_name
  `
  return rows.map((row) => row.table_name)
}

export const countByColumn = async (
  prisma: PrismaClient,
  column: string,
  value: string,
  exempt: readonly string[] = ERASURE_EXEMPT_TABLES,
): Promise<Record<string, number>> => {
  const tables = (await tablesWithColumn(prisma, column)).filter((table) => !exempt.includes(table))

  const counts: Record<string, number> = {}
  for (const table of tables) {
    const rows = await prisma.$queryRawUnsafe<{ count: number }[]>(
      `SELECT count(*)::int AS count FROM ${identifier(table)} WHERE ${identifier(column)} = $1::uuid`,
      value,
    )
    const count = Number(rows[0]?.count ?? 0)
    if (count > 0) counts[table] = count
  }
  return counts
}

const sum = (counts: Record<string, number>): number =>
  Object.values(counts).reduce((total, count) => total + count, 0)

export const verifyErasure = async (
  prisma: PrismaClient,
  target: ErasureTarget,
): Promise<Record<string, number>> => {
  const residue = await countByColumn(prisma, scopeColumn(target.kind), target.id)

  // The tenant's own row carries an id, not a scope column, so the sweep above cannot see
  // it — and a surviving project row is the loudest possible failure.
  const root =
    target.kind === 'project'
      ? await prisma.project.count({ where: { id: target.id } })
      : await prisma.org.count({ where: { id: target.id } })
  if (root > 0) residue[target.kind] = root

  return residue
}

const REMOVE_BATCH = 1000

export const eraseArtifacts = async (store: ArtifactSweeper, prefix: string): Promise<number> => {
  const objects = await store.list(prefix)
  const keys = objects.map((object) => object.key)
  for (let index = 0; index < keys.length; index += REMOVE_BATCH) {
    await store.remove(keys.slice(index, index + REMOVE_BATCH))
  }
  return keys.length
}

/**
 * Artifacts go first. Once the rows are gone nothing is left that says which object keys
 * belonged to this tenant, so a store failure after the delete would strand them in the
 * bucket permanently — with the prefix recorded on the request, a crash before the delete
 * is merely a retry.
 *
 * Deletes are `deleteMany` rather than `delete` for the same reason: the sweep runs again
 * after a crash, and a retry must not fail because the first pass already succeeded.
 */
export const eraseTarget = async (
  prisma: PrismaClient,
  store: ArtifactSweeper | null,
  target: ErasureTarget,
): Promise<ErasureOutcome> => {
  const artifactsDeleted = store ? await eraseArtifacts(store, target.artifactPrefix) : 0

  const before = await countByColumn(prisma, scopeColumn(target.kind), target.id)

  if (target.kind === 'project') {
    await prisma.project.deleteMany({ where: { id: target.id } })
  } else {
    await prisma.org.deleteMany({ where: { id: target.id } })
  }

  const residue = await verifyErasure(prisma, target)
  if (store) {
    const left = await store.list(target.artifactPrefix)
    if (left.length > 0) residue[ARTIFACT_RESIDUE_KEY] = left.length
  }

  return {
    rowsDeleted: sum(before),
    artifactsDeleted,
    residue,
    verified: Object.keys(residue).length === 0,
  }
}

/**
 * Called when the request is made, not when the sweep runs. Between the two a pipeline
 * that still holds a token would keep sending runs into the project being erased, and an
 * erasure racing an ingest never converges.
 */
export const haltIngestion = async (
  prisma: PrismaClient,
  target: Pick<ErasureTarget, 'kind' | 'id'>,
  now: Date = new Date(),
): Promise<number> => {
  const where =
    target.kind === 'project'
      ? { projectId: target.id, revokedAt: null }
      : { orgId: target.id, revokedAt: null }
  const { count } = await prisma.ingestToken.updateMany({ where, data: { revokedAt: now } })
  return count
}
