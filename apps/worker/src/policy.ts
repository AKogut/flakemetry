import {
  normalizePolicyOverrides,
  projectPolicyEnvOverrides,
  resolveProjectPolicy,
} from '@flakemetry/contracts'
import type { PrismaClient } from '@flakemetry/db'

export interface ScoringPolicy {
  threshold: number
  minSamples: number
  aiEnabled: boolean
  dailyTokenBudget: number
}

const DEFAULT_DAILY_TOKEN_BUDGET = 200_000

const readDailyTokenBudget = (env: Record<string, string | undefined>): number => {
  const raw = env.FLAKEMETRY_AI_DAILY_TOKEN_BUDGET
  if (!raw) return DEFAULT_DAILY_TOKEN_BUDGET
  const value = Number(raw)
  return Number.isFinite(value) && value >= 0 ? value : DEFAULT_DAILY_TOKEN_BUDGET
}

export const loadScoringPolicy = async (
  prisma: PrismaClient,
  projectId: string,
): Promise<ScoringPolicy> => {
  const row = await prisma.projectPolicy.findUnique({ where: { projectId } })
  const effective = resolveProjectPolicy({
    ui: normalizePolicyOverrides(row),
    env: projectPolicyEnvOverrides(process.env),
  })
  return {
    threshold: effective.flakyThreshold.value,
    minSamples: effective.minSamples.value,
    aiEnabled: effective.aiRcaEnabled.value,
    dailyTokenBudget: readDailyTokenBudget(process.env),
  }
}
