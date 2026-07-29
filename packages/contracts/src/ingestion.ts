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

export const artifactRefSchema = z.object({
  name: z.string().min(1),
  contentType: z.string().min(1),
  path: z.string().min(1),
})

export const MAX_SPANS_PER_EXECUTION = 500

export const spanKindSchema = z.enum(['step', 'http', 'browser', 'other'])

export const spanStatusSchema = z.enum(['ok', 'error', 'unset'])

export const ingestSpanSchema = z.object({
  spanId: z.string().min(1),
  parentSpanId: z.string().min(1).nullish(),
  name: z.string().min(1),
  kind: spanKindSchema.default('other'),
  status: spanStatusSchema.default('unset'),
  startedAt: timestampSchema,
  durationMs: z.number().int().nonnegative(),
  attributes: jsonRecordSchema.nullish(),
  error: ingestErrorSchema.nullish(),
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
  artifacts: z.array(artifactRefSchema).nullish(),
  attributes: jsonRecordSchema.nullish(),
  traceId: z.string().min(1).nullish(),
  spanId: z.string().min(1).nullish(),
  spans: z.array(ingestSpanSchema).max(MAX_SPANS_PER_EXECUTION).nullish(),
})

export const ingestRunSchema = z.object({
  status: runStatusSchema,
  startedAt: timestampSchema,
  finishedAt: timestampSchema.nullish(),
  traceId: z.string().min(1).nullish(),
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
export type ArtifactRef = z.infer<typeof artifactRefSchema>
export type SpanKind = z.infer<typeof spanKindSchema>
export type SpanStatus = z.infer<typeof spanStatusSchema>
export type IngestSpan = z.infer<typeof ingestSpanSchema>
export type IngestExecution = z.infer<typeof ingestExecutionSchema>
export type IngestRun = z.infer<typeof ingestRunSchema>
export type IngestRunBatch = z.infer<typeof ingestRunBatchSchema>
export type IngestAck = z.infer<typeof ingestAckSchema>
