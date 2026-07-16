import { z } from 'zod'

import { idSchema, jsonRecordSchema, testStatusSchema, timestampSchema } from '../common'

export const testExecutionSchema = z.object({
  id: idSchema,
  projectId: idSchema,
  runId: idSchema,
  testIdentityId: idSchema,
  attempt: z.number().int().min(1),
  retryOf: idSchema.nullable(),
  status: testStatusSchema,
  durationMs: z.number().int().nonnegative(),
  errorMessage: z.string().nullable(),
  errorSignatureId: idSchema.nullable(),
  otelTraceId: z.string().nullable(),
  otelSpanId: z.string().nullable(),
  artifactsRef: jsonRecordSchema.nullable(),
  attributes: jsonRecordSchema.nullable(),
  startedAt: timestampSchema,
})

export type TestExecution = z.infer<typeof testExecutionSchema>
