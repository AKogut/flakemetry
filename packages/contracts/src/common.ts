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

export const paginatedSchema = <T extends z.ZodTypeAny>(item: T) =>
  z.object({
    items: z.array(item),
    nextCursor: z.string().nullable(),
  })

export type TestStatus = z.infer<typeof testStatusSchema>
export type RunStatus = z.infer<typeof runStatusSchema>
export type CiProvider = z.infer<typeof ciProviderSchema>
export type RunTrigger = z.infer<typeof runTriggerSchema>
export type JsonRecord = z.infer<typeof jsonRecordSchema>
