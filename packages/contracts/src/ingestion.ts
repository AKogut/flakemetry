import { z } from 'zod'

import {
  ciProviderSchema,
  commitShaSchema,
  jsonRecordSchema,
  runStatusSchema,
  runTriggerSchema,
  semverSchema,
  testStatusSchema,
  timestampSchema,
} from './common'

export const ingestResourceSchema = z.object({
  ciProvider: ciProviderSchema,
  ciRunId: z.string().nullish(),
  commitSha: commitShaSchema,
  branch: z.string().min(1),
  prNumber: z.number().int().positive().nullish(),
  trigger: runTriggerSchema,
})

export const ingestErrorSchema = z.object({
  type: z.string().nullish(),
  message: z.string().min(1),
  stack: z.string().nullish(),
})

export const ingestExecutionSchema = z.object({
  filePath: z.string().min(1),
  suite: z.string(),
  title: z.string().min(1),
  params: jsonRecordSchema.nullish(),
  status: testStatusSchema,
  attempt: z.number().int().min(1).default(1),
  retryOfIndex: z.number().int().nonnegative().nullish(),
  startedAt: timestampSchema,
  durationMs: z.number().int().nonnegative(),
  error: ingestErrorSchema.nullish(),
  attributes: jsonRecordSchema.nullish(),
})

export const ingestRunSchema = z.object({
  status: runStatusSchema,
  startedAt: timestampSchema,
  finishedAt: timestampSchema.nullish(),
})

export const ingestRunBatchSchema = z.object({
  contractVersion: semverSchema,
  idempotencyKey: z.string().min(8).max(128),
  resource: ingestResourceSchema,
  run: ingestRunSchema,
  executions: z.array(ingestExecutionSchema).max(5000),
})

export const ingestAckSchema = z.object({
  receiptId: z.string().min(1),
  acceptedExecutions: z.number().int().nonnegative(),
})

export type IngestResource = z.infer<typeof ingestResourceSchema>
export type IngestError = z.infer<typeof ingestErrorSchema>
export type IngestExecution = z.infer<typeof ingestExecutionSchema>
export type IngestRun = z.infer<typeof ingestRunSchema>
export type IngestRunBatch = z.infer<typeof ingestRunBatchSchema>
export type IngestAck = z.infer<typeof ingestAckSchema>
