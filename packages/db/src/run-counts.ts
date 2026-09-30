import type { PrismaClient } from '@prisma/client'

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
        flaky_count = coalesce(counts.flaky, 0)
    FROM run AS target
    LEFT JOIN (
      SELECT run_id,
             count(*) FILTER (WHERE status = 'pass') AS passed,
             count(*) FILTER (WHERE status = 'fail') AS failed,
             count(*) FILTER (WHERE status = 'skip') AS skipped,
             count(*) FILTER (WHERE status = 'flaky') AS flaky
      FROM test_execution
      WHERE project_id = ${projectId}::uuid
      GROUP BY run_id
    ) AS counts ON counts.run_id = target.id
    WHERE run.id = target.id AND target.project_id = ${projectId}::uuid
  `
