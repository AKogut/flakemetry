import {
  normalizePolicyOverrides,
  projectPolicyEnvOverrides,
  resolveProjectPolicy,
} from '@flakemetry/contracts'
import type { PrismaClient } from '@flakemetry/db'
import {
  type ObjectStore,
  projectArtifactPrefix,
  pruneArtifacts,
  pruneArtifactsToSize,
} from '@flakemetry/storage'

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
  } else if (artifactDays !== null) {
    artifactDays = null
  }
  return { projectId: input.projectId, orgId: input.orgId, executionDays, artifactDays }
}

export const MEGABYTE = 1024 * 1024

const CAP_BATCH = 10_000

export const capRawExecutions = async (
  prisma: PrismaClient,
  projectId: string,
  maxExecutions: number,
): Promise<number> => {
  if (maxExecutions <= 0) return 0
  let pruned = 0
  for (;;) {
    const stored = await prisma.testExecution.count({ where: { projectId } })
    const excess = stored - maxExecutions
    if (excess <= 0) return pruned
    const oldest = await prisma.testExecution.findMany({
      where: { projectId },
      orderBy: [{ startedAt: 'asc' }, { id: 'asc' }],
      take: Math.min(excess, CAP_BATCH),
      select: { id: true },
    })
    const { count } = await prisma.testExecution.deleteMany({
      where: { id: { in: oldest.map((execution) => execution.id) } },
    })
    pruned += count
    if (count === 0) return pruned
  }
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
      policy: true,
    },
  })

  const envOverrides = projectPolicyEnvOverrides(env)
  let executionsPruned = 0
  let artifactsPruned = 0
  for (const project of projects) {
    const effective = resolveProjectPolicy({
      ui: normalizePolicyOverrides(project.policy),
      env: envOverrides,
    })
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

    executionsPruned += await capRawExecutions(
      prisma,
      project.id,
      effective.storageMaxExecutions.value,
    )

    if (store && effective.storageMaxArtifactMb.value > 0) {
      const result = await pruneArtifactsToSize(store, {
        prefix: projectArtifactPrefix(project.orgId, project.id),
        maxBytes: effective.storageMaxArtifactMb.value * MEGABYTE,
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
