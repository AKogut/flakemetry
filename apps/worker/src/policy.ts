import {
  normalizePolicyOverrides,
  projectPolicyEnvOverrides,
  resolveProjectPolicy,
} from '@flakemetry/contracts'
import type { PrismaClient } from '@flakemetry/db'

export interface ScoringPolicy {
  threshold: number
  minSamples: number
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
  return { threshold: effective.flakyThreshold.value, minSamples: effective.minSamples.value }
}
