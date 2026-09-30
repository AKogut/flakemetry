import { z } from 'zod'

export const POLICY_DEFAULTS = {
  flakyThreshold: 0.8,
  minSamples: 5,
  quarantineEnabled: false,
  quarantineCooldownRuns: 20,
  aiRcaEnabled: true,
  aiDailyTokenBudget: 200_000,
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
  aiDailyTokenBudget: number
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
  'aiDailyTokenBudget',
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
    aiDailyTokenBudget: z.number().int().min(0).nullable(),
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
  aiDailyTokenBudget: ResolvedPolicyField<number>
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
  aiDailyTokenBudget: resolveField('aiDailyTokenBudget', layers),
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

type NumericPolicyField = {
  [K in keyof ProjectPolicyValues]: ProjectPolicyValues[K] extends number ? K : never
}[keyof ProjectPolicyValues]

type BooleanPolicyField = {
  [K in keyof ProjectPolicyValues]: ProjectPolicyValues[K] extends boolean ? K : never
}[keyof ProjectPolicyValues]

const NUMERIC_POLICY_ENV: ReadonlyArray<readonly [string, NumericPolicyField]> = [
  ['FLAKEMETRY_FLAKY_THRESHOLD', 'flakyThreshold'],
  ['FLAKEMETRY_FLAKY_MIN_SAMPLES', 'minSamples'],
  ['FLAKEMETRY_QUARANTINE_COOLDOWN_RUNS', 'quarantineCooldownRuns'],
  ['FLAKEMETRY_AI_DAILY_TOKEN_BUDGET', 'aiDailyTokenBudget'],
  ['FLAKEMETRY_CI_MINUTE_COST', 'ciMinuteCost'],
  ['FLAKEMETRY_DEVELOPER_HOUR_COST', 'developerHourCost'],
  ['FLAKEMETRY_INVESTIGATION_MINUTES', 'investigationMinutes'],
  ['FLAKEMETRY_TRACKER_AFTER_DAYS', 'trackerAfterDays'],
  ['FLAKEMETRY_TRACKER_RECOVERY_DAYS', 'trackerRecoveryDays'],
]

const BOOLEAN_POLICY_ENV: ReadonlyArray<readonly [string, BooleanPolicyField]> = [
  ['FLAKEMETRY_QUARANTINE_ENABLED', 'quarantineEnabled'],
  ['FLAKEMETRY_AI_RCA', 'aiRcaEnabled'],
  ['FLAKEMETRY_TRACKER_ENABLED', 'trackerEnabled'],
]

export const POLICY_ENV_VARIABLES: readonly string[] = [
  ...NUMERIC_POLICY_ENV,
  ...BOOLEAN_POLICY_ENV,
].map(([name]) => name)

const parseBoolean = (value: string): boolean => value === 'true' || value === '1'

const parsePolicyNumber = (field: NumericPolicyField, raw: string): number | undefined => {
  const parsed = projectPolicyInputSchema.shape[field].safeParse(Number(raw))
  return parsed.success && typeof parsed.data === 'number' ? parsed.data : undefined
}

export const projectPolicyEnvOverrides = (
  env: Record<string, string | undefined>,
): Partial<ProjectPolicyValues> => {
  const overrides: Partial<ProjectPolicyValues> = {}
  for (const [name, field] of NUMERIC_POLICY_ENV) {
    const raw = env[name]?.trim()
    if (!raw) continue
    const value = parsePolicyNumber(field, raw)
    if (value !== undefined) overrides[field] = value
  }
  for (const [name, field] of BOOLEAN_POLICY_ENV) {
    const raw = env[name]
    if (raw !== undefined && raw !== '') overrides[field] = parseBoolean(raw)
  }
  return overrides
}
