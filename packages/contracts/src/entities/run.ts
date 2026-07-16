import { z } from 'zod'

import {
  ciProviderSchema,
  commitShaSchema,
  idSchema,
  jsonRecordSchema,
  runStatusSchema,
  runTriggerSchema,
  timestampSchema,
} from '../common'

export const runSchema = z.object({
  id: idSchema,
  projectId: idSchema,
  commitSha: commitShaSchema,
  branch: z.string().min(1),
  prNumber: z.number().int().positive().nullable(),
  ciProvider: ciProviderSchema,
  ciRunId: z.string().nullable(),
  trigger: runTriggerSchema,
  status: runStatusSchema,
  startedAt: timestampSchema,
  finishedAt: timestampSchema.nullable(),
  durationMs: z.number().int().nonnegative().nullable(),
  gitDiffStat: jsonRecordSchema.nullable(),
  otelTraceId: z.string().nullable(),
})

export type Run = z.infer<typeof runSchema>
