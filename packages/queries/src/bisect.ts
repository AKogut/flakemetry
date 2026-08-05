import type { PrismaClient } from '@flakemetry/db'

export interface BisectPoint {
  runId: string
  commitSha: string
  branch: string
  startedAt: Date
  status: string
}

export interface SuspectCommit {
  commitSha: string
  runId: string
  startedAt: Date
  /** 0 is the commit the test first failed on; larger is further back towards the last green run. */
  distance: number
}

export type BisectVerdict = 'identified' | 'narrowed' | 'inconclusive'

export interface FlakeWindow {
  firstBadRun: BisectPoint
  lastGoodRun: BisectPoint | null
  stableRunsBefore: number
}

export interface FlakeBisect {
  verdict: BisectVerdict
  reason: string
  window: FlakeWindow | null
  suspects: SuspectCommit[]
}

/**
 * How much unbroken green a test needs before a failure counts as an onset rather than as
 * more of the same. Without it, a test that has always been unreliable would name whatever
 * commit happens to sit at the start of its retained history — a confident wrong answer,
 * which is worse than declining to answer.
 */
export const MIN_STABLE_RUNS = 5

/** Past this the window says so little that naming a top suspect would be theatre. */
export const MAX_USEFUL_SUSPECTS = 10

const isBad = (status: string): boolean => status === 'fail' || status === 'flaky'

/**
 * Finds the moment a test stopped being reliable: the first failure that follows a long
 * enough green streak. Pure, and separate from ranking suspects, because "when did this
 * start" and "what could have caused it" are answerable to different degrees — the first
 * from this test's own history, the second only as well as the project's run history allows.
 */
export const findFlakeOnset = (history: readonly BisectPoint[]): FlakeWindow | null => {
  const ordered = [...history].sort(
    (left, right) => left.startedAt.getTime() - right.startedAt.getTime(),
  )

  let stableStreak = 0
  for (const [index, entry] of ordered.entries()) {
    if (isBad(entry.status)) {
      if (stableStreak >= MIN_STABLE_RUNS) {
        return {
          firstBadRun: entry,
          lastGoodRun: ordered[index - 1] ?? null,
          stableRunsBefore: stableStreak,
        }
      }
      stableStreak = 0
      continue
    }
    if (entry.status === 'pass') stableStreak += 1
  }

  return null
}

/**
 * The commits that could have done it are those the project ran between the last green run
 * of this test and its first failure. This test's own history cannot supply them — a suite
 * does not run every test on every commit — but the project's other runs in that window can,
 * which is why the ranking reaches past the single test.
 *
 * Ordering is by proximity to the failure. Deliberately not by which files a commit touched:
 * that needs diffs, and Flakemetry ingests test results, not source control. Proximity is a
 * real signal; inventing file attribution would not be.
 */
export const rankSuspects = (
  window: FlakeWindow,
  projectRuns: readonly BisectPoint[],
): SuspectCommit[] => {
  const from = window.lastGoodRun?.startedAt.getTime() ?? Number.NEGATIVE_INFINITY
  const to = window.firstBadRun.startedAt.getTime()

  const inWindow = projectRuns
    .filter((run) => run.startedAt.getTime() > from && run.startedAt.getTime() <= to)
    .sort((left, right) => right.startedAt.getTime() - left.startedAt.getTime())

  const seen = new Set<string>()
  const suspects: SuspectCommit[] = []
  for (const run of inWindow) {
    if (seen.has(run.commitSha)) continue
    seen.add(run.commitSha)
    suspects.push({
      commitSha: run.commitSha,
      runId: run.runId,
      startedAt: run.startedAt,
      distance: suspects.length,
    })
  }

  return suspects
}

export const explainBisect = (
  window: FlakeWindow | null,
  suspects: readonly SuspectCommit[],
  hadFailure: boolean,
  hasHistory: boolean,
): FlakeBisect => {
  if (!window) {
    if (!hasHistory) {
      return {
        verdict: 'inconclusive',
        reason: 'no runs recorded for this test yet',
        window: null,
        suspects: [],
      }
    }
    return {
      verdict: 'inconclusive',
      reason: hadFailure
        ? `no streak of ${MIN_STABLE_RUNS} green runs precedes a failure — this test has been unreliable for as long as its history goes back`
        : 'this test has not failed in its retained history',
      window: null,
      suspects: [],
    }
  }

  if (suspects.length === 1) {
    return {
      verdict: 'identified',
      reason: `the test passed ${window.stableRunsBefore} run(s) in a row, and exactly one commit ran before it failed`,
      window,
      suspects: [...suspects],
    }
  }

  if (suspects.length > 1 && suspects.length <= MAX_USEFUL_SUSPECTS) {
    return {
      verdict: 'narrowed',
      reason: `${suspects.length} commits ran between the last green run and the first failure, newest first`,
      window,
      suspects: [...suspects],
    }
  }

  return {
    verdict: 'inconclusive',
    reason:
      suspects.length === 0
        ? 'no run recorded between the last green run and the first failure'
        : `${suspects.length} commits sit between the last green run and the first failure — too wide a window to name a suspect`,
    window,
    suspects: suspects.slice(0, MAX_USEFUL_SUSPECTS),
  }
}

const HISTORY_LIMIT = 200
const SUSPECT_RUN_LIMIT = 500

export const getFlakeBisect = async (
  prisma: PrismaClient,
  projectId: string,
  testIdentityId: string,
): Promise<FlakeBisect> => {
  const executions = await prisma.testExecution.findMany({
    where: {
      projectId,
      testIdentityId,
      // First attempts only. A retry is the same commit re-run, so counting one would make
      // every retried failure look like an onset of its own.
      attempt: 1,
    },
    orderBy: { startedAt: 'desc' },
    take: HISTORY_LIMIT,
    select: {
      status: true,
      startedAt: true,
      run: { select: { id: true, commitSha: true, branch: true } },
    },
  })

  const history: BisectPoint[] = executions.map((execution) => ({
    runId: execution.run.id,
    commitSha: execution.run.commitSha,
    branch: execution.run.branch,
    startedAt: execution.startedAt,
    status: execution.status,
  }))

  const window = findFlakeOnset(history)
  const hadFailure = history.some((entry) => isBad(entry.status))

  if (!window) return explainBisect(null, [], hadFailure, history.length > 0)

  const runs = await prisma.run.findMany({
    where: {
      projectId,
      branch: window.firstBadRun.branch,
      startedAt: {
        ...(window.lastGoodRun ? { gt: window.lastGoodRun.startedAt } : {}),
        lte: window.firstBadRun.startedAt,
      },
    },
    orderBy: { startedAt: 'desc' },
    take: SUSPECT_RUN_LIMIT,
    select: { id: true, commitSha: true, branch: true, startedAt: true },
  })

  const suspects = rankSuspects(
    window,
    runs.map((run) => ({
      runId: run.id,
      commitSha: run.commitSha,
      branch: run.branch,
      startedAt: run.startedAt,
      status: 'pass',
    })),
  )

  return explainBisect(window, suspects, hadFailure, true)
}
