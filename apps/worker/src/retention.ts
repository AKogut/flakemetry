import type { PrismaClient } from '@flakemetry/db'
import { type ObjectStore, projectArtifactPrefix, pruneArtifacts } from '@flakemetry/storage'

import { pruneRawExecutions } from './rollups'

export interface RetentionGlobals {
  executionDays: number | null
  artifactDays: number | null
}

export interface RetentionInput {
  projectId: string
  orgId: string
  executionRetentionDays: number | null
  artifactRetentionDays: number | null
}

export interface RetentionPlan {
  projectId: string
  orgId: string
  executionDays: number | null
  artifactDays: number | null
}

const positive = (value: number | null | undefined): number | null =>
  typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : null

export const parseRetentionGlobals = (
  env: Record<string, string | undefined>,
): RetentionGlobals => ({
  executionDays: positive(Number(env.FLAKEMETRY_EXECUTION_RETENTION_DAYS)),
  artifactDays: positive(Number(env.FLAKEMETRY_ARTIFACT_RETENTION_DAYS)),
})

export const resolveRetentionPlan = (
  input: RetentionInput,
  globals: RetentionGlobals,
): RetentionPlan => {
  const executionDays = positive(input.executionRetentionDays) ?? globals.executionDays
  let artifactDays = positive(input.artifactRetentionDays) ?? globals.artifactDays
  if (executionDays !== null) {
    artifactDays = Math.max(artifactDays ?? executionDays, executionDays)
  }
  return { projectId: input.projectId, orgId: input.orgId, executionDays, artifactDays }
}

export const runRetentionSweep = async (
  prisma: PrismaClient,
  store: ObjectStore | null,
  env: Record<string, string | undefined>,
  now: Date = new Date(),
): Promise<{ executionsPruned: number; artifactsPruned: number }> => {
  const globals = parseRetentionGlobals(env)
  const projects = await prisma.project.findMany({
    select: {
      id: true,
      orgId: true,
      policy: { select: { executionRetentionDays: true, artifactRetentionDays: true } },
    },
  })

  let executionsPruned = 0
  let artifactsPruned = 0
  for (const project of projects) {
    const plan = resolveRetentionPlan(
      {
        projectId: project.id,
        orgId: project.orgId,
        executionRetentionDays: project.policy?.executionRetentionDays ?? null,
        artifactRetentionDays: project.policy?.artifactRetentionDays ?? null,
      },
      globals,
    )

    if (plan.executionDays !== null) {
      executionsPruned += await pruneRawExecutions(prisma, {
        olderThanDays: plan.executionDays,
        projectId: plan.projectId,
        now,
      })
    }

    if (store && plan.artifactDays !== null) {
      const result = await pruneArtifacts(store, {
        prefix: projectArtifactPrefix(plan.orgId, plan.projectId),
        olderThanDays: plan.artifactDays,
        now,
      })
      artifactsPruned += result.deleted.length
    }
  }

  return { executionsPruned, artifactsPruned }
}

const RETENTION_INTERVAL_MS = 6 * 60 * 60 * 1000

export const startRetention = (
  prisma: PrismaClient,
  store: ObjectStore | null,
  env: Record<string, string | undefined> = process.env,
): void => {
  const sweep = (): void => {
    void runRetentionSweep(prisma, store, env)
      .then(({ executionsPruned, artifactsPruned }) => {
        if (executionsPruned > 0)
          process.stdout.write(`worker: pruned ${executionsPruned} raw execution(s)\n`)
        if (artifactsPruned > 0)
          process.stdout.write(`worker: pruned ${artifactsPruned} expired artifact(s)\n`)
      })
      .catch((error: unknown) => {
        process.stderr.write(`worker: retention sweep failed ${String(error)}\n`)
      })
  }

  sweep()
  setInterval(sweep, RETENTION_INTERVAL_MS).unref()
}
