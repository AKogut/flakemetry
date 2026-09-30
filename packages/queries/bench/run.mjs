import { performance } from 'node:perf_hooks'

import { createPrismaClient } from '@flakemetry/db'
import {
  flakyBoard,
  getClusterImpact,
  getDailyTrend,
  getExecutionCluster,
  getExecutionTrace,
  getFlakeBisect,
  getFlakinessCost,
  getFlakyTrend,
  getPrGate,
  getProjectHealthKpis,
  getProjectUsage,
  getRun,
  getRunSummaryByCommit,
  getSuiteHealth,
  getTeamHealthLeaderboard,
  getTest,
  getTestHealthMetrics,
  getTestLeaderboards,
  listRuns,
} from '@flakemetry/queries'

const ITERATIONS = Number(process.env.BENCH_ITERATIONS ?? 20)
const PROJECT = '00000000-0000-4000-8000-000000000002'
const prisma = createPrismaClient()

const latestRun = await prisma.run.findFirstOrThrow({
  where: { projectId: PROJECT, branch: 'main' },
  orderBy: { startedAt: 'desc' },
  select: { id: true, commitSha: true },
})
const flaky = await prisma.flakyScore.findFirstOrThrow({
  where: { projectId: PROJECT },
  orderBy: { score: 'desc' },
  select: { testIdentityId: true },
})
const failing = await prisma.testExecution.findFirstOrThrow({
  where: { runId: latestRun.id, status: 'fail' },
  select: { id: true },
})
const traced = await prisma.testExecution.findFirstOrThrow({
  where: { runId: latestRun.id, NOT: { otelSpanId: null } },
  select: { id: true },
})

const rates = { ciMinuteCost: 0.008, developerHourCost: 75, investigationMinutes: 20 }

const queries = {
  'runs list (page of 20)': () => listRuns(prisma, PROJECT, { limit: 20 }),
  'run detail (every execution of one run)': () => getRun(prisma, PROJECT, latestRun.id),
  'test detail (60 runs of history)': () => getTest(prisma, PROJECT, flaky.testIdentityId, 60),
  'flaky board (top 20)': () =>
    flakyBoard(prisma, PROJECT, { limit: 20, minScore: 0, includeQuarantined: true }),
  'suite health (14 days)': () => getSuiteHealth(prisma, PROJECT, 14),
  'flaky trend (30 days)': () => getFlakyTrend(prisma, PROJECT, 30),
  'health KPIs (14 days)': () => getProjectHealthKpis(prisma, PROJECT, 14),
  'daily trend (14 days)': () => getDailyTrend(prisma, PROJECT, 14),
  'leaderboards (14 days)': () => getTestLeaderboards(prisma, PROJECT, 14, 8),
  'test health metrics (90 days)': () => getTestHealthMetrics(prisma, PROJECT, 90),
  'team health (90 days)': () => getTeamHealthLeaderboard(prisma, PROJECT, 90),
  'cost of flakiness (30 days)': () => getFlakinessCost(prisma, PROJECT, 30, rates),
  'usage page': () => getProjectUsage(prisma, PROJECT, 100_000),
  'trace (one execution)': () => getExecutionTrace(prisma, PROJECT, traced.id),
  'error cluster (one failure)': () => getExecutionCluster(prisma, PROJECT, failing.id),
  'cluster impact (one failure)': () => getClusterImpact(prisma, PROJECT, failing.id),
  'flake bisect (one test)': () => getFlakeBisect(prisma, PROJECT, flaky.testIdentityId),
  'run summary by commit': () => getRunSummaryByCommit(prisma, PROJECT, latestRun.commitSha),
  'PR gate': () => getPrGate(prisma, PROJECT, latestRun.commitSha, { baseBranch: 'main' }),
  'retention count': () => prisma.testExecution.count({ where: { projectId: PROJECT } }),
}

const percentile = (sorted, p) =>
  sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)]

const executions = await prisma.testExecution.count()
process.stdout.write(`${executions} executions, ${ITERATIONS} iterations after one warm-up\n\n`)
process.stdout.write('| query | p50 ms | p95 ms | max ms |\n| --- | ---: | ---: | ---: |\n')

for (const [name, run] of Object.entries(queries)) {
  await run()
  const timings = []
  for (let iteration = 0; iteration < ITERATIONS; iteration += 1) {
    const start = performance.now()
    await run()
    timings.push(performance.now() - start)
  }
  timings.sort((a, b) => a - b)
  const format = (value) => value.toFixed(1)
  process.stdout.write(
    `| ${name} | ${format(percentile(timings, 50))} | ${format(percentile(timings, 95))} | ${format(timings.at(-1))} |\n`,
  )
}

await prisma.$disconnect()
