import type { PrismaClient } from '@flakemetry/db'

export interface CostRates {
  ciMinuteCost: number
  developerHourCost: number
  investigationMinutes: number
}

export interface CostTotals {
  rerunCount: number
  rerunMs: number
  flakyOccurrences: number
  ciSpend: number
  peopleSpend: number
  totalSpend: number
}

export interface CostOffender {
  testIdentityId: string
  title: string
  suite: string
  filePath: string
  quarantined: boolean
  rerunCount: number
  rerunMs: number
  flakyOccurrences: number
  spend: number
}

export interface CostDay {
  day: Date
  rerunMs: number
  flakyOccurrences: number
  spend: number
}

export interface FlakinessCost {
  days: number
  rates: CostRates
  totals: CostTotals
  offenders: CostOffender[]
  trend: CostDay[]
  avoided: {
    quarantinedTests: number
    flakyOccurrences: number
    peopleSpend: number
  }
}

const OFFENDER_LIMIT = 10
const MS_PER_MINUTE = 60_000
const MINUTES_PER_HOUR = 60

const round = (value: number): number => Math.round(value * 100) / 100

/**
 * Retry wall-clock is measured, not modelled: an attempt beyond the first exists only
 * because an earlier one failed, so its duration is CI time a non-flaky suite would not
 * have spent. Money is that number multiplied by rates the project sets, which is why the
 * rates travel with the result — a figure whose assumptions are off-screen is not one
 * anybody should take to a budget conversation.
 */
export const ciSpendOf = (rerunMs: number, rates: CostRates): number =>
  (rerunMs / MS_PER_MINUTE) * rates.ciMinuteCost

/**
 * The half that is an estimate. A flaky occurrence is a test that needed a retry to pass,
 * which is the moment somebody looks at a red build that turns out to mean nothing.
 */
export const peopleSpendOf = (flakyOccurrences: number, rates: CostRates): number =>
  ((flakyOccurrences * rates.investigationMinutes) / MINUTES_PER_HOUR) * rates.developerHourCost

const since = (days: number, now: Date): Date => {
  const start = new Date(now)
  start.setUTCHours(0, 0, 0, 0)
  start.setUTCDate(start.getUTCDate() - (days - 1))
  return start
}

const dayString = (date: Date): string => date.toISOString().slice(0, 10)

interface CandidateRow {
  test_identity_id: string
  title: string
  suite: string
  file_path: string
  quarantined: boolean
  rerun_count: bigint
  rerun_ms: bigint
  flaky: bigint
}

export const getFlakinessCost = async (
  prisma: PrismaClient,
  projectId: string,
  days: number,
  rates: CostRates,
  now: Date = new Date(),
): Promise<FlakinessCost> => {
  const from = dayString(since(days, now))

  const [dayRows, candidates, avoidedRows] = await Promise.all([
    prisma.$queryRaw<{ day: Date; rerun_count: bigint; rerun_ms: bigint; flaky: bigint }[]>`
      SELECT day,
             sum(rerun_count)::bigint AS rerun_count,
             sum(rerun_ms)::bigint AS rerun_ms,
             sum(flaky)::bigint AS flaky
      FROM daily_test_stats
      WHERE project_id = ${projectId}::uuid AND day >= ${from}::date
      GROUP BY day
      ORDER BY day
    `,
    prisma.$queryRaw<CandidateRow[]>`
      WITH per_test AS (
        SELECT test_identity_id,
               sum(rerun_count)::bigint AS rerun_count,
               sum(rerun_ms)::bigint AS rerun_ms,
               sum(flaky)::bigint AS flaky
        FROM daily_test_stats
        WHERE project_id = ${projectId}::uuid
          AND day >= ${from}::date
          AND (rerun_count > 0 OR rerun_ms > 0 OR flaky > 0)
        GROUP BY test_identity_id
        HAVING sum(rerun_count) > 0 OR sum(flaky) > 0
      )
      SELECT per_test.test_identity_id, identity.title, identity.suite, identity.file_path,
             identity.quarantined, per_test.rerun_count, per_test.rerun_ms, per_test.flaky
      FROM per_test
      JOIN test_identity identity ON identity.id = per_test.test_identity_id
    `,
    prisma.$queryRaw<{ quarantined_tests: bigint; flaky: bigint | null }[]>`
      SELECT count(DISTINCT stats.test_identity_id) AS quarantined_tests,
             sum(stats.flaky)::bigint AS flaky
      FROM test_identity identity
      JOIN daily_test_stats stats
        ON stats.test_identity_id = identity.id AND stats.day >= ${from}::date
      WHERE identity.project_id = ${projectId}::uuid
        AND stats.project_id = ${projectId}::uuid
        AND identity.quarantined
    `,
  ])

  const totals: CostTotals = {
    rerunCount: 0,
    rerunMs: 0,
    flakyOccurrences: 0,
    ciSpend: 0,
    peopleSpend: 0,
    totalSpend: 0,
  }
  for (const row of dayRows) {
    totals.rerunCount += Number(row.rerun_count)
    totals.rerunMs += Number(row.rerun_ms)
    totals.flakyOccurrences += Number(row.flaky)
  }
  totals.ciSpend = round(ciSpendOf(totals.rerunMs, rates))
  totals.peopleSpend = round(peopleSpendOf(totals.flakyOccurrences, rates))
  totals.totalSpend = round(totals.ciSpend + totals.peopleSpend)

  const offenders = candidates
    .map((row): CostOffender => {
      const rerunMs = Number(row.rerun_ms)
      const flakyOccurrences = Number(row.flaky)
      return {
        testIdentityId: row.test_identity_id,
        title: row.title,
        suite: row.suite,
        filePath: row.file_path,
        quarantined: row.quarantined,
        rerunCount: Number(row.rerun_count),
        rerunMs,
        flakyOccurrences,
        spend: round(ciSpendOf(rerunMs, rates) + peopleSpendOf(flakyOccurrences, rates)),
      }
    })
    .sort(
      (left, right) =>
        right.spend - left.spend ||
        right.rerunMs - left.rerunMs ||
        (left.testIdentityId < right.testIdentityId ? -1 : 1),
    )
    .slice(0, OFFENDER_LIMIT)

  // A quarantined test still runs, so its CI minutes are not saved. What quarantine
  // removes is the interruption: it no longer fails anybody's build. Claiming the CI
  // time back as well would be the kind of number that falls apart when questioned.
  const avoidedFlaky = Number(avoidedRows[0]?.flaky ?? 0)

  return {
    days,
    rates,
    totals,
    offenders,
    trend: dayRows.map((row) => {
      const rerunMs = Number(row.rerun_ms)
      const flakyOccurrences = Number(row.flaky)
      return {
        day: row.day,
        rerunMs,
        flakyOccurrences,
        spend: round(ciSpendOf(rerunMs, rates) + peopleSpendOf(flakyOccurrences, rates)),
      }
    }),
    avoided: {
      quarantinedTests: Number(avoidedRows[0]?.quarantined_tests ?? 0),
      flakyOccurrences: avoidedFlaky,
      peopleSpend: round(peopleSpendOf(avoidedFlaky, rates)),
    },
  }
}
