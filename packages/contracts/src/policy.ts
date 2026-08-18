import { z } from 'zod'

export const POLICY_DEFAULTS = {
  flakyThreshold: 0.8,
  minSamples: 5,
  quarantineEnabled: false,
  quarantineCooldownRuns: 20,
  aiRcaEnabled: true,
  // GitHub's published rate for a 2-core Linux runner. A starting point that is a real,
  // citable number rather than an invented one — every project should set its own.
  ciMinuteCost: 0.008,
  developerHourCost: 75,
  investigationMinutes: 15,
  trackerEnabled: false,
  // Long enough that a test which flakes once on a bad afternoon does not earn a ticket,
  // short enough that a real one is filed while the change that caused it is still recent.
  trackerAfterDays: 3,
  trackerRecoveryDays: 7,
} as const

export type ProjectPolicyValues = {
  flakyThreshold: number
  minSamples: number
  quarantineEnabled: boolean
  quarantineCooldownRuns: number
  aiRcaEnabled: boolean
  executionRetentionDays: number
  artifactRetentionDays: number
  ciMinuteCost: number
  developerHourCost: number
  investigationMinutes: number
  trackerEnabled: boolean
  trackerAfterDays: number
  trackerRecoveryDays: number
}

export const POLICY_FIELDS = [
  'flakyThreshold',
  'minSamples',
  'quarantineEnabled',
  'quarantineCooldownRuns',
  'aiRcaEnabled',
  'executionRetentionDays',
  'artifactRetentionDays',
  'ciMinuteCost',
  'developerHourCost',
  'investigationMinutes',
  'trackerEnabled',
  'trackerAfterDays',
  'trackerRecoveryDays',
] as const

export type PolicyField = (typeof POLICY_FIELDS)[number]

export const projectPolicyInputSchema = z
  .object({
    flakyThreshold: z.number().min(0).max(1).nullable(),
    minSamples: z.number().int().min(1).nullable(),
    quarantineEnabled: z.boolean().nullable(),
    quarantineCooldownRuns: z.number().int().min(1).nullable(),
    aiRcaEnabled: z.boolean().nullable(),
    executionRetentionDays: z.number().int().min(1).nullable(),
    artifactRetentionDays: z.number().int().min(1).nullable(),
    ciMinuteCost: z.number().min(0).nullable(),
    developerHourCost: z.number().min(0).nullable(),
    investigationMinutes: z.number().int().min(0).nullable(),
    trackerEnabled: z.boolean().nullable(),
    trackerAfterDays: z.number().int().min(1).nullable(),
    trackerRecoveryDays: z.number().int().min(1).nullable(),
  })
  .strict()
  .partial()

export type ProjectPolicyInput = z.infer<typeof projectPolicyInputSchema>

export type PolicySource = 'default' | 'ui' | 'env'

export type ResolvedPolicyField<T> = {
  value: T
  source: PolicySource
}

export type EffectiveProjectPolicy = {
  flakyThreshold: ResolvedPolicyField<number>
  minSamples: ResolvedPolicyField<number>
  quarantineEnabled: ResolvedPolicyField<boolean>
  quarantineCooldownRuns: ResolvedPolicyField<number>
  aiRcaEnabled: ResolvedPolicyField<boolean>
  ciMinuteCost: ResolvedPolicyField<number>
  developerHourCost: ResolvedPolicyField<number>
  investigationMinutes: ResolvedPolicyField<number>
  trackerEnabled: ResolvedPolicyField<boolean>
  trackerAfterDays: ResolvedPolicyField<number>
  trackerRecoveryDays: ResolvedPolicyField<number>
}

export type PolicyOverrides = Partial<{ [K in PolicyField]: ProjectPolicyValues[K] | null }>

export type PolicyLayers = {
  ui?: PolicyOverrides | null
  env?: PolicyOverrides | null
}

const resolveField = <K extends keyof typeof POLICY_DEFAULTS>(
  field: K,
  layers: PolicyLayers,
): ResolvedPolicyField<ProjectPolicyValues[K]> => {
  const envValue = layers.env?.[field]
  if (envValue !== undefined && envValue !== null)
    return { value: envValue as ProjectPolicyValues[K], source: 'env' }
  const uiValue = layers.ui?.[field]
  if (uiValue !== undefined && uiValue !== null)
    return { value: uiValue as ProjectPolicyValues[K], source: 'ui' }
  return { value: POLICY_DEFAULTS[field] as ProjectPolicyValues[K], source: 'default' }
}

export const resolveProjectPolicy = (layers: PolicyLayers): EffectiveProjectPolicy => ({
  flakyThreshold: resolveField('flakyThreshold', layers),
  minSamples: resolveField('minSamples', layers),
  quarantineEnabled: resolveField('quarantineEnabled', layers),
  quarantineCooldownRuns: resolveField('quarantineCooldownRuns', layers),
  aiRcaEnabled: resolveField('aiRcaEnabled', layers),
  ciMinuteCost: resolveField('ciMinuteCost', layers),
  developerHourCost: resolveField('developerHourCost', layers),
  investigationMinutes: resolveField('investigationMinutes', layers),
  trackerEnabled: resolveField('trackerEnabled', layers),
  trackerAfterDays: resolveField('trackerAfterDays', layers),
  trackerRecoveryDays: resolveField('trackerRecoveryDays', layers),
})

export const normalizePolicyOverrides = (
  source: Partial<Record<PolicyField, number | boolean | null | undefined>> | null | undefined,
): Partial<ProjectPolicyValues> => {
  const overrides: Partial<ProjectPolicyValues> = {}
  if (!source) return overrides
  for (const field of POLICY_FIELDS) {
    const value = source[field]
    if (value !== null && value !== undefined)
      (overrides as Record<string, number | boolean>)[field] = value
  }
  return overrides
}

export type ScoringPolicyValues = Pick<
  ProjectPolicyValues,
  'flakyThreshold' | 'minSamples' | 'quarantineEnabled' | 'quarantineCooldownRuns' | 'aiRcaEnabled'
>

export const effectivePolicyValues = (policy: EffectiveProjectPolicy): ScoringPolicyValues => ({
  flakyThreshold: policy.flakyThreshold.value,
  minSamples: policy.minSamples.value,
  quarantineEnabled: policy.quarantineEnabled.value,
  quarantineCooldownRuns: policy.quarantineCooldownRuns.value,
  aiRcaEnabled: policy.aiRcaEnabled.value,
})

const parseBoolean = (value: string): boolean => value === 'true' || value === '1'

export const projectPolicyEnvOverrides = (
  env: Record<string, string | undefined>,
): Partial<ProjectPolicyValues> => {
  const overrides: Partial<ProjectPolicyValues> = {}
  if (env.FLAKEMETRY_FLAKY_THRESHOLD !== undefined && env.FLAKEMETRY_FLAKY_THRESHOLD !== '')
    overrides.flakyThreshold = Number(env.FLAKEMETRY_FLAKY_THRESHOLD)
  if (env.FLAKEMETRY_FLAKY_MIN_SAMPLES !== undefined && env.FLAKEMETRY_FLAKY_MIN_SAMPLES !== '')
    overrides.minSamples = Number(env.FLAKEMETRY_FLAKY_MIN_SAMPLES)
  if (env.FLAKEMETRY_QUARANTINE_ENABLED !== undefined && env.FLAKEMETRY_QUARANTINE_ENABLED !== '')
    overrides.quarantineEnabled = parseBoolean(env.FLAKEMETRY_QUARANTINE_ENABLED)
  if (
    env.FLAKEMETRY_QUARANTINE_COOLDOWN_RUNS !== undefined &&
    env.FLAKEMETRY_QUARANTINE_COOLDOWN_RUNS !== ''
  )
    overrides.quarantineCooldownRuns = Number(env.FLAKEMETRY_QUARANTINE_COOLDOWN_RUNS)
  if (env.FLAKEMETRY_AI_RCA !== undefined && env.FLAKEMETRY_AI_RCA !== '')
    overrides.aiRcaEnabled = parseBoolean(env.FLAKEMETRY_AI_RCA)
  if (env.FLAKEMETRY_CI_MINUTE_COST !== undefined && env.FLAKEMETRY_CI_MINUTE_COST !== '')
    overrides.ciMinuteCost = Number(env.FLAKEMETRY_CI_MINUTE_COST)
  if (env.FLAKEMETRY_DEVELOPER_HOUR_COST !== undefined && env.FLAKEMETRY_DEVELOPER_HOUR_COST !== '')
    overrides.developerHourCost = Number(env.FLAKEMETRY_DEVELOPER_HOUR_COST)
  if (
    env.FLAKEMETRY_INVESTIGATION_MINUTES !== undefined &&
    env.FLAKEMETRY_INVESTIGATION_MINUTES !== ''
  )
    overrides.investigationMinutes = Number(env.FLAKEMETRY_INVESTIGATION_MINUTES)
  // The tracker fields were in POLICY_FIELDS, in both compose files, in .env.example and
  // in the configuration reference, and read by nothing — so setting them did nothing and
  // the dashboard reported the source as "default". policy-env.test.ts now fails if any
  // effective-policy field loses its environment tier again.
  if (env.FLAKEMETRY_TRACKER_ENABLED !== undefined && env.FLAKEMETRY_TRACKER_ENABLED !== '')
    overrides.trackerEnabled = parseBoolean(env.FLAKEMETRY_TRACKER_ENABLED)
  if (env.FLAKEMETRY_TRACKER_AFTER_DAYS !== undefined && env.FLAKEMETRY_TRACKER_AFTER_DAYS !== '')
    overrides.trackerAfterDays = Number(env.FLAKEMETRY_TRACKER_AFTER_DAYS)
  if (
    env.FLAKEMETRY_TRACKER_RECOVERY_DAYS !== undefined &&
    env.FLAKEMETRY_TRACKER_RECOVERY_DAYS !== ''
  )
    overrides.trackerRecoveryDays = Number(env.FLAKEMETRY_TRACKER_RECOVERY_DAYS)
  return overrides
}
