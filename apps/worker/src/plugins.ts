import {
  type AnalyzerHistoryEntry,
  type AnalyzerInput,
  type FlakemetryPlugin,
  MAX_HISTORY_PER_TEST,
  type PluginSignal,
  pluginSignalsSchema,
  type TestStatus,
} from '@flakemetry/contracts'
import { Prisma, type PrismaClient } from '@flakemetry/db'
import { withDeadline } from '@flakemetry/plugin-host'

import { workerMetrics } from './telemetry'

export interface AnalyzerRun {
  orgId: string
  projectId: string
  runId: string
}

export interface AnalyzerOptions {
  timeoutMs: number
}

interface HistoryRow {
  test_identity_id: string
  run_id: string
  commit_sha: string
  started_at: Date
  status: TestStatus
  attempt: number
  duration_ms: number
}

const loadInput = async (prisma: PrismaClient, run: AnalyzerRun): Promise<AnalyzerInput | null> => {
  const row = await prisma.run.findFirst({
    where: { id: run.runId, projectId: run.projectId },
    select: { id: true, commitSha: true, branch: true, startedAt: true },
  })
  if (!row) return null
  const executions = await prisma.testExecution.findMany({
    where: { runId: run.runId, projectId: run.projectId },
    select: {
      testIdentityId: true,
      status: true,
      attempt: true,
      durationMs: true,
      errorMessage: true,
      identity: { select: { filePath: true, suite: true, title: true } },
    },
  })
  return {
    projectId: run.projectId,
    run: row,
    executions: executions.map((execution) => ({
      testIdentityId: execution.testIdentityId,
      filePath: execution.identity.filePath,
      suite: execution.identity.suite,
      title: execution.identity.title,
      status: execution.status,
      attempt: execution.attempt,
      durationMs: execution.durationMs,
      errorMessage: execution.errorMessage,
    })),
  }
}

const historyReader =
  (prisma: PrismaClient, run: AnalyzerRun, inRun: ReadonlySet<string>) =>
  async (
    testIdentityIds: readonly string[],
    options: { limit?: number } = {},
  ): Promise<Record<string, AnalyzerHistoryEntry[]>> => {
    const ids = [...new Set(testIdentityIds)].filter((id) => inRun.has(id))
    const result: Record<string, AnalyzerHistoryEntry[]> = {}
    for (const id of ids) result[id] = []
    if (ids.length === 0) return result
    const limit = Math.min(Math.max(1, Math.floor(options.limit ?? 20)), MAX_HISTORY_PER_TEST)
    const rows = await prisma.$queryRaw<HistoryRow[]>`
      SELECT test_identity_id, run_id, commit_sha, started_at, status, attempt, duration_ms
      FROM (
        SELECT e.test_identity_id, e.run_id, r.commit_sha, e.started_at, e.status::text AS status,
               e.attempt, e.duration_ms,
               ROW_NUMBER() OVER (PARTITION BY e.test_identity_id ORDER BY e.started_at DESC) AS position
        FROM test_execution e
        JOIN run r ON r.id = e.run_id
        WHERE e.project_id = ${run.projectId}::uuid
          AND e.run_id <> ${run.runId}::uuid
          AND e.test_identity_id IN (${Prisma.join(ids.map((id) => Prisma.sql`${id}::uuid`))})
      ) ranked
      WHERE position <= ${limit}
      ORDER BY test_identity_id, started_at DESC`
    for (const row of rows) {
      result[row.test_identity_id]?.push({
        runId: row.run_id,
        commitSha: row.commit_sha,
        startedAt: row.started_at,
        status: row.status,
        attempt: row.attempt,
        durationMs: row.duration_ms,
      })
    }
    return result
  }

const applySignals = async (
  prisma: PrismaClient,
  plugin: string,
  run: AnalyzerRun,
  inRun: ReadonlySet<string>,
  signals: readonly PluginSignal[],
): Promise<void> => {
  const flagged = new Set(signals.map((signal) => `${signal.testIdentityId}:${signal.code}`))
  const existing = await prisma.pluginSignal.findMany({
    where: { projectId: run.projectId, plugin, testIdentityId: { in: [...inRun] } },
    select: { id: true, testIdentityId: true, code: true },
  })
  const cleared = existing
    .filter((row) => !flagged.has(`${row.testIdentityId}:${row.code}`))
    .map((row) => row.id)

  await prisma.$transaction([
    prisma.pluginSignal.deleteMany({ where: { id: { in: cleared } } }),
    ...signals.map((signal) =>
      prisma.pluginSignal.upsert({
        where: {
          testIdentityId_plugin_code: {
            testIdentityId: signal.testIdentityId,
            plugin,
            code: signal.code,
          },
        },
        create: {
          orgId: run.orgId,
          projectId: run.projectId,
          testIdentityId: signal.testIdentityId,
          runId: run.runId,
          plugin,
          code: signal.code,
          severity: signal.severity,
          message: signal.message,
          data: (signal.data ?? Prisma.JsonNull) as Prisma.InputJsonValue,
        },
        update: {
          runId: run.runId,
          severity: signal.severity,
          message: signal.message,
          data: (signal.data ?? Prisma.JsonNull) as Prisma.InputJsonValue,
        },
      }),
    ),
  ])
}

export const runAnalyzers = async (
  prisma: PrismaClient,
  plugins: readonly FlakemetryPlugin[],
  run: AnalyzerRun,
  options: AnalyzerOptions,
): Promise<void> => {
  const analyzers = plugins.filter((plugin) => plugin.analyze)
  if (analyzers.length === 0) return

  const input = await loadInput(prisma, run)
  if (!input || input.executions.length === 0) return
  const inRun = new Set(input.executions.map((execution) => execution.testIdentityId))
  const history = historyReader(prisma, run, inRun)

  for (const plugin of analyzers) {
    try {
      const raw = await withDeadline(
        () =>
          plugin.analyze?.(input, {
            history,
            deadline: new Date(Date.now() + options.timeoutMs),
          }) ?? [],
        options.timeoutMs,
        `plugin ${plugin.name}`,
      )
      const parsed = pluginSignalsSchema.safeParse(raw)
      if (!parsed.success) {
        const issue = parsed.error.issues[0]
        throw new Error(
          `returned signals that do not match the contract: ${issue?.path.join('.')} ${issue?.message}`,
        )
      }
      const signals = parsed.data.filter((signal) => inRun.has(signal.testIdentityId))
      await applySignals(prisma, plugin.name, run, inRun, signals)
      workerMetrics.pluginSignals.add(signals.length, { plugin: plugin.name })
    } catch (error) {
      workerMetrics.pluginFailures.add(1, { plugin: plugin.name })
      process.stderr.write(
        `worker: plugin ${plugin.name} failed on run ${run.runId}: ${error instanceof Error ? error.message : String(error)}\n`,
      )
    }
  }
}
