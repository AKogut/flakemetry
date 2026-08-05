import { z } from 'zod'

export const CONTRACT_VERSION = '0.1.0'

export const idSchema = z.string().uuid()
export const timestampSchema = z.coerce.date()
export const commitShaSchema = z.string().regex(/^[0-9a-f]{7,40}$/i)
export const semverSchema = z.string().regex(/^\d+\.\d+\.\d+$/)
export const fingerprintSchema = z.string().min(1)

export const testStatusSchema = z.enum(['pass', 'fail', 'skip', 'flaky'])
export const runStatusSchema = z.enum(['running', 'passed', 'failed', 'canceled'])
export const ciProviderSchema = z.enum([
  'github_actions',
  'gitlab_ci',
  'circleci',
  'jenkins',
  'local',
  'other',
])
export const runTriggerSchema = z.enum(['push', 'pull_request', 'schedule', 'manual', 'other'])

export type JsonValue =
  string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue }

export const jsonValueSchema: z.ZodType<JsonValue> = z.lazy(() =>
  z.union([
    z.string(),
    z.number(),
    z.boolean(),
    z.null(),
    z.array(jsonValueSchema),
    z.record(jsonValueSchema),
  ]),
)

export const jsonRecordSchema = z.record(jsonValueSchema)

export type TestStatus = z.infer<typeof testStatusSchema>
export type RunStatus = z.infer<typeof runStatusSchema>
export type CiProvider = z.infer<typeof ciProviderSchema>
export type RunTrigger = z.infer<typeof runTriggerSchema>
export type JsonRecord = z.infer<typeof jsonRecordSchema>

/**
 * What a project token is allowed to do. `ingest` writes results; `read` serves the public
 * REST API. They are separate so a credential handed to a script or a dashboard cannot also
 * forge test data.
 */
export const TOKEN_SCOPES = ['ingest', 'read'] as const

export type TokenScope = (typeof TOKEN_SCOPES)[number]

export const isTokenScope = (value: string): value is TokenScope =>
  (TOKEN_SCOPES as readonly string[]).includes(value)
