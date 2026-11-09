import { extractTestCaseId, TEST_CASE_ID_PATTERN } from '@flakemetry/core'
import type { PrismaClient } from '@flakemetry/db'

import { loadRunFailures, type RunFailures } from './run-failures'

export interface TestCaseRunCounts {
  passed: number
  failed: number
  flaky: number
}

export interface TestCaseTest {
  id: string
  title: string
}

export interface TestCaseCell extends TestCaseRunCounts {
  variant: string
  tests: TestCaseTest[]
}

export interface TestCaseRow {
  caseId: string
  trouble: number
  cells: TestCaseCell[]
}

export interface TestCaseVariantTotals extends TestCaseRunCounts {
  variant: string
  cases: number
}

export interface TestCaseCoverage {
  runs: number
  olderRunsLeftOut: boolean
}

export interface TestCaseMatrix {
  variants: TestCaseVariantTotals[]
  cases: TestCaseRow[]
  comparable: boolean
  coverage: TestCaseCoverage
}

export const TEST_CASE_RUN_LIMIT = 500
export const TEST_CASE_EXECUTION_LIMIT = 50_000

interface CaseTest extends TestCaseTest {
  caseId: string
  variant: string
}

interface RecentRun {
  id: string
  stored_executions: number
}

interface OutcomeRow extends TestCaseRunCounts {
  case_id: string
  variant: string
}

const MIN_VARIANTS_TO_COMPARE = 2

const NATURAL_ORDER = new Intl.Collator('en', { numeric: true })

const loadCaseTests = async (prisma: PrismaClient, projectId: string): Promise<CaseTest[]> => {
  const rows = await prisma.$queryRaw<{ id: string; title: string; variant: string }[]>`
    SELECT id, title, params->>'variant' AS variant
    FROM test_identity
    WHERE project_id = ${projectId}::uuid
      AND jsonb_typeof(params->'variant') = 'string'
      AND params->>'variant' <> ''
      AND title ~ ${TEST_CASE_ID_PATTERN.source}
    ORDER BY last_seen_at DESC, id
  `
  return rows.flatMap((row) => {
    const caseId = extractTestCaseId(row.title)
    return caseId ? [{ ...row, caseId }] : []
  })
}

const hasCaseOnSeveralVariants = (tests: readonly CaseTest[]): boolean => {
  const variantsByCase = new Map<string, Set<string>>()
  for (const test of tests) {
    const variants = variantsByCase.get(test.caseId) ?? new Set<string>()
    variants.add(test.variant)
    variantsByCase.set(test.caseId, variants)
  }
  return [...variantsByCase.values()].some((variants) => variants.size >= MIN_VARIANTS_TO_COMPARE)
}

const loadRecentRuns = async (
  prisma: PrismaClient,
  projectId: string,
): Promise<{ runs: RecentRun[]; olderRunsLeftOut: boolean }> => {
  const latest = await prisma.$queryRaw<RecentRun[]>`
    SELECT id, stored_executions
    FROM run
    WHERE project_id = ${projectId}::uuid
    ORDER BY started_at DESC, id DESC
    LIMIT ${TEST_CASE_RUN_LIMIT + 1}
  `
  const runs: RecentRun[] = []
  let executions = 0
  for (const run of latest.slice(0, TEST_CASE_RUN_LIMIT)) {
    executions += run.stored_executions
    if (runs.length > 0 && executions > TEST_CASE_EXECUTION_LIMIT) break
    runs.push(run)
  }
  return { runs, olderRunsLeftOut: runs.length < latest.length }
}

const loadOutcomes = (
  prisma: PrismaClient,
  tests: readonly CaseTest[],
  runs: readonly RecentRun[],
  runFailures: ReadonlyMap<string, RunFailures>,
): Promise<OutcomeRow[]> => {
  const ids = tests.map((test) => test.id)
  const caseIds = tests.map((test) => test.caseId)
  const variants = tests.map((test) => test.variant)
  const runIds = runs.map((run) => run.id)
  const massFailureRunIds = [...runFailures]
    .filter(([, run]) => run.massFailure)
    .map(([runId]) => runId)
  const sharedFailures = [...runFailures].flatMap(([runId, run]) =>
    [...run.sharedFailures].map((testIdentityId) => ({ runId, testIdentityId })),
  )
  const sharedRunIds = sharedFailures.map((failure) => failure.runId)
  const sharedTestIds = sharedFailures.map((failure) => failure.testIdentityId)
  return prisma.$queryRaw<OutcomeRow[]>`
    WITH catalogue AS (
      SELECT *
      FROM unnest(${ids}::uuid[], ${caseIds}::text[], ${variants}::text[])
        AS entry(test_identity_id, case_id, variant)
    ),
    shared_failure AS (
      SELECT *
      FROM unnest(${sharedRunIds}::uuid[], ${sharedTestIds}::uuid[])
        AS entry(run_id, test_identity_id)
    ),
    test_in_run AS (
      SELECT e.test_identity_id, e.run_id,
             (array_agg(e.status::text ORDER BY e.attempt DESC, e.ordinal DESC NULLS LAST))[1]
               = 'fail' AS ended_failing,
             bool_or(e.status IN ('fail', 'flaky')) AS had_failure
      FROM test_execution e
      WHERE e.run_id = ANY(${runIds}::uuid[])
        AND e.status <> 'skip'
        AND NOT (e.status = 'fail' AND e.run_id = ANY(${massFailureRunIds}::uuid[]))
        AND NOT (
          e.status = 'fail'
          AND EXISTS (
            SELECT 1 FROM shared_failure s
            WHERE s.run_id = e.run_id AND s.test_identity_id = e.test_identity_id
          )
        )
      GROUP BY e.run_id, e.test_identity_id
    ),
    case_in_run AS (
      SELECT catalogue.case_id, catalogue.variant, test_in_run.run_id,
             bool_or(test_in_run.ended_failing) AS failed,
             bool_or(test_in_run.had_failure) AS had_failure
      FROM test_in_run
      JOIN catalogue USING (test_identity_id)
      GROUP BY catalogue.case_id, catalogue.variant, test_in_run.run_id
    )
    SELECT case_id, variant,
           count(*) FILTER (WHERE NOT had_failure)::int AS passed,
           count(*) FILTER (WHERE failed)::int AS failed,
           count(*) FILTER (WHERE had_failure AND NOT failed)::int AS flaky
    FROM case_in_run
    GROUP BY case_id, variant
  `
}

const cellKey = (caseId: string, variant: string): string => `${caseId}\u0000${variant}`

export const getTestCaseMatrix = async (
  prisma: PrismaClient,
  projectId: string,
): Promise<TestCaseMatrix> => {
  const tests = await loadCaseTests(prisma, projectId)
  if (tests.length === 0) {
    return {
      variants: [],
      cases: [],
      comparable: false,
      coverage: { runs: 0, olderRunsLeftOut: false },
    }
  }

  const { runs, olderRunsLeftOut } = await loadRecentRuns(prisma, projectId)
  const runFailures = await loadRunFailures(
    prisma,
    projectId,
    runs.map((run) => run.id),
  )
  const outcomes = await loadOutcomes(prisma, tests, runs, runFailures)
  const outcomeOf = new Map(outcomes.map((row) => [cellKey(row.case_id, row.variant), row]))

  const cellsByCase = new Map<string, Map<string, TestCaseCell>>()
  for (const test of tests) {
    const cells = cellsByCase.get(test.caseId) ?? new Map<string, TestCaseCell>()
    const outcome = outcomeOf.get(cellKey(test.caseId, test.variant))
    const cell = cells.get(test.variant) ?? {
      variant: test.variant,
      passed: outcome?.passed ?? 0,
      failed: outcome?.failed ?? 0,
      flaky: outcome?.flaky ?? 0,
      tests: [],
    }
    cell.tests.push({ id: test.id, title: test.title })
    cells.set(test.variant, cell)
    cellsByCase.set(test.caseId, cells)
  }

  const cases = [...cellsByCase.entries()]
    .map(([caseId, cells]) => {
      const row = [...cells.values()].sort((a, b) => NATURAL_ORDER.compare(a.variant, b.variant))
      const trouble = row.reduce((sum, cell) => sum + cell.failed + cell.flaky, 0)
      return { caseId, trouble, cells: row }
    })
    .sort((a, b) => b.trouble - a.trouble || NATURAL_ORDER.compare(a.caseId, b.caseId))

  const totals = new Map<string, TestCaseVariantTotals>()
  for (const cell of cases.flatMap((row) => row.cells)) {
    const total = totals.get(cell.variant)
    totals.set(cell.variant, {
      variant: cell.variant,
      passed: (total?.passed ?? 0) + cell.passed,
      failed: (total?.failed ?? 0) + cell.failed,
      flaky: (total?.flaky ?? 0) + cell.flaky,
      cases: (total?.cases ?? 0) + 1,
    })
  }

  return {
    variants: [...totals.values()].sort((a, b) => NATURAL_ORDER.compare(a.variant, b.variant)),
    cases,
    comparable: hasCaseOnSeveralVariants(tests),
    coverage: { runs: runs.length, olderRunsLeftOut },
  }
}

export const hasTestCaseComparison = async (
  prisma: PrismaClient,
  projectId: string,
): Promise<boolean> => hasCaseOnSeveralVariants(await loadCaseTests(prisma, projectId))
