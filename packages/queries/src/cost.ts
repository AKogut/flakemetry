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

export const getFlakinessCost = async (
  prisma: PrismaClient,
  projectId: string,
  days: number,
  rates: CostRates,
  now: Date = new Date(),
): Promise<FlakinessCost> => {
  const from = since(days, now)

  const rows = await prisma.dailyTestStats.findMany({
    where: { projectId, day: { gte: from } },
    select: {
      day: true,
      testIdentityId: true,
      rerunCount: true,
      rerunMs: true,
      flaky: true,
      identity: { select: { title: true, suite: true, filePath: true, quarantined: true } },
    },
  })

  const totals: CostTotals = {
    rerunCount: 0,
    rerunMs: 0,
    flakyOccurrences: 0,
    ciSpend: 0,
    peopleSpend: 0,
    totalSpend: 0,
  }
  const byTest = new Map<string, CostOffender>()
  const byDay = new Map<number, CostDay>()
  const avoided = { quarantinedTests: new Set<string>(), flakyOccurrences: 0, peopleSpend: 0 }

  for (const row of rows) {
    totals.rerunCount += row.rerunCount
    totals.rerunMs += row.rerunMs
    totals.flakyOccurrences += row.flaky

    const test = byTest.get(row.testIdentityId) ?? {
      testIdentityId: row.testIdentityId,
      title: row.identity.title,
      suite: row.identity.suite,
      filePath: row.identity.filePath,
      quarantined: row.identity.quarantined,
      rerunCount: 0,
      rerunMs: 0,
      flakyOccurrences: 0,
      spend: 0,
    }
    test.rerunCount += row.rerunCount
    test.rerunMs += row.rerunMs
    test.flakyOccurrences += row.flaky
    byTest.set(row.testIdentityId, test)

    const key = row.day.getTime()
    const day = byDay.get(key) ?? { day: row.day, rerunMs: 0, flakyOccurrences: 0, spend: 0 }
    day.rerunMs += row.rerunMs
    day.flakyOccurrences += row.flaky
    byDay.set(key, day)

    // A quarantined test still runs, so its CI minutes are not saved. What quarantine
    // removes is the interruption: it no longer fails anybody's build. Claiming the CI
    // time back as well would be the kind of number that falls apart when questioned.
    if (row.identity.quarantined) {
      avoided.quarantinedTests.add(row.testIdentityId)
      avoided.flakyOccurrences += row.flaky
    }
  }

  totals.ciSpend = round(ciSpendOf(totals.rerunMs, rates))
  totals.peopleSpend = round(peopleSpendOf(totals.flakyOccurrences, rates))
  totals.totalSpend = round(totals.ciSpend + totals.peopleSpend)

  for (const test of byTest.values()) {
    test.spend = round(ciSpendOf(test.rerunMs, rates) + peopleSpendOf(test.flakyOccurrences, rates))
  }
  for (const day of byDay.values()) {
    day.spend = round(ciSpendOf(day.rerunMs, rates) + peopleSpendOf(day.flakyOccurrences, rates))
  }

  const offenders = [...byTest.values()]
    .filter((test) => test.rerunCount > 0 || test.flakyOccurrences > 0)
    .sort((left, right) => right.spend - left.spend || right.rerunMs - left.rerunMs)
    .slice(0, OFFENDER_LIMIT)

  return {
    days,
    rates,
    totals,
    offenders,
    trend: [...byDay.values()].sort((left, right) => left.day.getTime() - right.day.getTime()),
    avoided: {
      quarantinedTests: avoided.quarantinedTests.size,
      flakyOccurrences: avoided.flakyOccurrences,
      peopleSpend: round(peopleSpendOf(avoided.flakyOccurrences, rates)),
    },
  }
}
