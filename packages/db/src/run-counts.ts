import { Prisma, type PrismaClient } from '@prisma/client'

export interface StatusCounts {
  passed: number
  failed: number
  skipped: number
  flaky: number
}

export const countStatuses = (statuses: Iterable<string>): StatusCounts => {
  const counts: StatusCounts = { passed: 0, failed: 0, skipped: 0, flaky: 0 }
  for (const status of statuses) {
    if (status === 'pass') counts.passed += 1
    else if (status === 'fail') counts.failed += 1
    else if (status === 'skip') counts.skipped += 1
    else if (status === 'flaky') counts.flaky += 1
  }
  return counts
}

export const runCountFields = (counts: StatusCounts) => ({
  passedCount: counts.passed,
  failedCount: counts.failed,
  skippedCount: counts.skipped,
  flakyCount: counts.flaky,
})

export const refreshRunCounts = (prisma: PrismaClient, projectId: string): Promise<number> =>
  prisma.$executeRaw`
    UPDATE run
    SET passed_count = coalesce(counts.passed, 0),
        failed_count = coalesce(counts.failed, 0),
        skipped_count = coalesce(counts.skipped, 0),
        flaky_count = coalesce(counts.flaky, 0),
        stored_executions = coalesce(counts.stored, 0)
    FROM run AS target
    LEFT JOIN (
      SELECT run_id,
             count(*) FILTER (WHERE status = 'pass') AS passed,
             count(*) FILTER (WHERE status = 'fail') AS failed,
             count(*) FILTER (WHERE status = 'skip') AS skipped,
             count(*) FILTER (WHERE status = 'flaky') AS flaky,
             count(*) AS stored
      FROM test_execution
      WHERE project_id = ${projectId}::uuid
      GROUP BY run_id
    ) AS counts ON counts.run_id = target.id
    WHERE run.id = target.id AND target.project_id = ${projectId}::uuid
  `

export const storedExecutionCount = async (
  prisma: PrismaClient,
  projectId: string,
): Promise<number> => {
  const [row] = await prisma.$queryRaw<{ stored: bigint | null }[]>`
    SELECT sum(stored_executions)::bigint AS stored FROM run WHERE project_id = ${projectId}::uuid
  `
  return Number(row?.stored ?? 0)
}

export const deleteExecutions = async (
  prisma: PrismaClient,
  where: Prisma.Sql,
): Promise<number> => {
  const [row] = await prisma.$queryRaw<{ deleted: bigint }[]>`
    WITH deleted AS (
      DELETE FROM test_execution WHERE ${where} RETURNING run_id
    ),
    per_run AS (
      SELECT run_id, count(*)::int AS removed FROM deleted GROUP BY run_id
    ),
    adjusted AS (
      UPDATE run
      SET stored_executions = greatest(run.stored_executions - per_run.removed, 0)
      FROM per_run
      WHERE run.id = per_run.run_id
      RETURNING run.id
    )
    SELECT (SELECT count(*) FROM deleted)::bigint AS deleted
  `
  return Number(row?.deleted ?? 0)
}

const utcTimestamp = (date: Date): string => date.toISOString().replace('T', ' ').replace('Z', '')

export const executionsOlderThan = (cutoff: Date, projectId?: string): Prisma.Sql =>
  projectId
    ? Prisma.sql`started_at < ${utcTimestamp(cutoff)}::timestamp AND project_id = ${projectId}::uuid`
    : Prisma.sql`started_at < ${utcTimestamp(cutoff)}::timestamp`

export const executionsWithIds = (ids: readonly string[]): Prisma.Sql =>
  Prisma.sql`id = ANY(${ids as string[]}::uuid[])`
