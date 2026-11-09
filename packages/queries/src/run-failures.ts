import { findSharedFailures, isMassFailureRun } from '@flakemetry/core'
import type { PrismaClient } from '@flakemetry/db'

export interface RunFailures {
  failingTests: Set<string>
  massFailure: boolean
  sharedFailures: Set<string>
}

export type FailureSetAside = 'mass' | 'shared'

interface FailingTestRow {
  run_id: string
  test_identity_id: string
  message: string | null
  recovered: boolean
  commit_sha: string
  passed_count: number
  flaky_count: number
}

interface SharedFailure {
  runId: string
  testIdentityId: string
  commitSha: string
}

const loadFailingTests = (
  prisma: PrismaClient,
  projectId: string,
  runIds: readonly string[],
): Promise<FailingTestRow[]> =>
  prisma.$queryRaw<FailingTestRow[]>`
    SELECT e.run_id, e.test_identity_id, r.commit_sha, r.passed_count, r.flaky_count,
           (array_agg(e.error_message ORDER BY e.attempt)
             FILTER (WHERE e.status = 'fail'))[1] AS message,
           bool_or(e.status IN ('pass', 'flaky')) AS recovered
    FROM test_execution e
    JOIN run r ON r.id = e.run_id
    WHERE e.project_id = ${projectId}::uuid
      AND e.run_id = ANY(${runIds as string[]}::uuid[])
    GROUP BY e.run_id, e.test_identity_id, r.commit_sha, r.passed_count, r.flaky_count
    HAVING bool_or(e.status = 'fail')
  `

const loadPassedElsewhere = async (
  prisma: PrismaClient,
  projectId: string,
  shared: readonly SharedFailure[],
): Promise<Set<string>> => {
  if (shared.length === 0) return new Set()

  const rows = await prisma.$queryRaw<{ run_id: string; test_identity_id: string }[]>`
    SELECT DISTINCT shared.run_id, shared.test_identity_id
    FROM unnest(
      ${shared.map((failure) => failure.runId)}::uuid[],
      ${shared.map((failure) => failure.testIdentityId)}::uuid[],
      ${shared.map((failure) => failure.commitSha)}::text[]
    ) AS shared(run_id, test_identity_id, commit_sha)
    JOIN test_execution e
      ON e.test_identity_id = shared.test_identity_id
     AND e.project_id = ${projectId}::uuid
     AND e.run_id <> shared.run_id
     AND e.status IN ('pass', 'flaky')
    JOIN run r ON r.id = e.run_id AND r.commit_sha = shared.commit_sha
  `
  return new Set(rows.map((row) => `${row.run_id}:${row.test_identity_id}`))
}

export const loadRunFailures = async (
  prisma: PrismaClient,
  projectId: string,
  runIds: readonly string[],
): Promise<Map<string, RunFailures>> => {
  if (runIds.length === 0) return new Map()

  const rowsByRun = new Map<string, FailingTestRow[]>()
  for (const row of await loadFailingTests(prisma, projectId, runIds)) {
    const rows = rowsByRun.get(row.run_id) ?? []
    rows.push(row)
    rowsByRun.set(row.run_id, rows)
  }

  const verdicts = new Map<string, RunFailures>()
  const candidates: SharedFailure[] = []
  for (const [runId, rows] of rowsByRun) {
    const failed = rows.length
    const executed = failed + Number(rows[0]?.passed_count) + Number(rows[0]?.flaky_count)
    const massFailure = isMassFailureRun({ failed, executed })
    const shared = massFailure
      ? new Set<string>()
      : findSharedFailures(
          rows.map((row) => ({
            testId: row.test_identity_id,
            message: row.message,
            recoveredInRun: row.recovered,
          })),
          executed,
        )
    for (const testIdentityId of shared) {
      candidates.push({ runId, testIdentityId, commitSha: rows[0]?.commit_sha as string })
    }
    verdicts.set(runId, {
      failingTests: new Set(rows.map((row) => row.test_identity_id)),
      massFailure,
      sharedFailures: new Set(),
    })
  }

  const passedElsewhere = await loadPassedElsewhere(prisma, projectId, candidates)
  for (const { runId, testIdentityId } of candidates) {
    if (passedElsewhere.has(`${runId}:${testIdentityId}`)) {
      verdicts.get(runId)?.sharedFailures.add(testIdentityId)
    }
  }

  return verdicts
}

export const failureSetAside = (
  failures: ReadonlyMap<string, RunFailures>,
  runId: string,
  testIdentityId: string,
): FailureSetAside | null => {
  const run = failures.get(runId)
  if (run?.massFailure) return 'mass'
  return run?.sharedFailures.has(testIdentityId) ? 'shared' : null
}
