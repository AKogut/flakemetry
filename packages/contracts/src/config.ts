import { z } from 'zod'

export const flakemetryConfigSchema = z
  .object({
    project: z.string().min(1).optional(),
    endpoint: z.string().url().optional(),
    flaky: z
      .object({
        threshold: z.number().min(0).max(1).default(0.8),
        minSamples: z.number().int().min(1).default(5),
      })
      .strict()
      .default({}),
    quarantine: z
      .object({
        enabled: z.boolean().default(false),
        cooldownRuns: z.number().int().min(1).default(20),
      })
      .strict()
      .default({}),
    ai: z
      .object({
        rca: z.boolean().default(true),
        dailyTokenBudget: z.number().int().nonnegative().default(200_000),
      })
      .strict()
      .default({}),
    ignore: z.array(z.string()).default([]),
    retention: z
      .object({
        rawDays: z.number().int().min(1).default(90),
      })
      .strict()
      .default({}),
  })
  .strict()

export type FlakemetryConfig = z.infer<typeof flakemetryConfigSchema>
export type FlakemetryConfigInput = z.input<typeof flakemetryConfigSchema>

export class ConfigValidationError extends Error {
  readonly issues: string[]

  constructor(issues: string[]) {
    super(`invalid flakemetry configuration:\n${issues.map((issue) => `  - ${issue}`).join('\n')}`)
    this.name = 'ConfigValidationError'
    this.issues = issues
  }
}

const formatIssues = (error: z.ZodError): string[] =>
  error.issues.map((issue) => {
    const path = issue.path.length > 0 ? issue.path.join('.') : '(root)'
    return `${path}: ${issue.message}`
  })

export const parseFlakemetryConfig = (data: unknown): FlakemetryConfig => {
  const result = flakemetryConfigSchema.safeParse(data ?? {})
  if (!result.success) throw new ConfigValidationError(formatIssues(result.error))
  return result.data
}

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const deepMerge = (
  base: Record<string, unknown>,
  override: Record<string, unknown>,
): Record<string, unknown> => {
  const merged: Record<string, unknown> = { ...base }
  for (const [key, value] of Object.entries(override)) {
    if (value === undefined) continue
    const current = merged[key]
    merged[key] = isPlainObject(current) && isPlainObject(value) ? deepMerge(current, value) : value
  }
  return merged
}

export const mergeConfigLayers = (...layers: (unknown | undefined)[]): FlakemetryConfig => {
  const merged = layers
    .filter((layer): layer is Record<string, unknown> => isPlainObject(layer))
    .reduce<Record<string, unknown>>((accumulated, layer) => deepMerge(accumulated, layer), {})
  return parseFlakemetryConfig(merged)
}

const parseBoolean = (value: string): boolean => value === 'true' || value === '1'

export const configFromEnv = (env: Record<string, string | undefined>): FlakemetryConfigInput => {
  const overrides: Record<string, unknown> = {}
  if (env.FLAKEMETRY_PROJECT) overrides.project = env.FLAKEMETRY_PROJECT
  if (env.FLAKEMETRY_ENDPOINT) overrides.endpoint = env.FLAKEMETRY_ENDPOINT
  const flaky: Record<string, unknown> = {}
  if (env.FLAKEMETRY_FLAKY_THRESHOLD) flaky.threshold = Number(env.FLAKEMETRY_FLAKY_THRESHOLD)
  if (env.FLAKEMETRY_FLAKY_MIN_SAMPLES) flaky.minSamples = Number(env.FLAKEMETRY_FLAKY_MIN_SAMPLES)
  if (Object.keys(flaky).length > 0) overrides.flaky = flaky
  const quarantine: Record<string, unknown> = {}
  if (env.FLAKEMETRY_QUARANTINE_ENABLED)
    quarantine.enabled = parseBoolean(env.FLAKEMETRY_QUARANTINE_ENABLED)
  if (env.FLAKEMETRY_QUARANTINE_COOLDOWN_RUNS)
    quarantine.cooldownRuns = Number(env.FLAKEMETRY_QUARANTINE_COOLDOWN_RUNS)
  if (Object.keys(quarantine).length > 0) overrides.quarantine = quarantine
  const ai: Record<string, unknown> = {}
  if (env.FLAKEMETRY_AI_RCA) ai.rca = parseBoolean(env.FLAKEMETRY_AI_RCA)
  if (env.FLAKEMETRY_AI_DAILY_TOKEN_BUDGET)
    ai.dailyTokenBudget = Number(env.FLAKEMETRY_AI_DAILY_TOKEN_BUDGET)
  if (Object.keys(ai).length > 0) overrides.ai = ai
  return overrides as FlakemetryConfigInput
}
