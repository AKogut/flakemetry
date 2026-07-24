import { z } from 'zod'

export const POLICY_DEFAULTS = {
  flakyThreshold: 0.8,
  minSamples: 5,
  quarantineEnabled: false,
  quarantineCooldownRuns: 20,
  aiRcaEnabled: true,
} as const

export type ProjectPolicyValues = {
  flakyThreshold: number
  minSamples: number
  quarantineEnabled: boolean
  quarantineCooldownRuns: number
  aiRcaEnabled: boolean
}

export const POLICY_FIELDS = [
  'flakyThreshold',
  'minSamples',
  'quarantineEnabled',
  'quarantineCooldownRuns',
  'aiRcaEnabled',
] as const

export type PolicyField = (typeof POLICY_FIELDS)[number]

export const projectPolicyInputSchema = z
  .object({
    flakyThreshold: z.number().min(0).max(1).nullable(),
    minSamples: z.number().int().min(1).nullable(),
    quarantineEnabled: z.boolean().nullable(),
    quarantineCooldownRuns: z.number().int().min(1).nullable(),
    aiRcaEnabled: z.boolean().nullable(),
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
}

export type PolicyOverrides = Partial<{ [K in PolicyField]: ProjectPolicyValues[K] | null }>

export type PolicyLayers = {
  ui?: PolicyOverrides | null
  env?: PolicyOverrides | null
}

const resolveField = <K extends PolicyField>(
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

export const effectivePolicyValues = (policy: EffectiveProjectPolicy): ProjectPolicyValues => ({
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
  return overrides
}
