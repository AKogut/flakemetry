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
  shardIndex: z.number().int().min(1).nullish(),
  shardTotal: z.number().int().min(1).nullish(),
})

export const ingestErrorSchema = z.object({
  type: z.string().nullish(),
  message: z.string().min(1),
  stack: z.string().nullish(),
})

export const MAX_ARTIFACT_BYTES = 50 * 1024 * 1024

export const ALLOWED_ARTIFACT_CONTENT_TYPES = [
  'image/png',
  'image/jpeg',
  'image/webp',
  'video/webm',
  'video/mp4',
  'application/zip',
  'application/json',
  'text/plain',
  'text/html',
] as const

export const artifactContentType = (contentType: string): string =>
  contentType.split(';')[0]!.trim().toLowerCase()

export const isAllowedArtifactContentType = (contentType: string): boolean =>
  (ALLOWED_ARTIFACT_CONTENT_TYPES as readonly string[]).includes(artifactContentType(contentType))

export const artifactRefSchema = z.object({
  name: z.string().min(1),
  contentType: z.string().min(1),
  path: z.string().min(1),
  key: z.string().min(1).nullish(),
  sizeBytes: z.number().int().nonnegative().max(MAX_ARTIFACT_BYTES).nullish(),
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

export const junitIngestSchema = z.object({
  idempotencyKey: z.string().min(8),
  resource: ingestResourceSchema,
  xml: z.string().min(1),
})

export const ingestAckSchema = z.object({
  receiptId: z.string().min(1),
  acceptedExecutions: z.number().int().nonnegative(),
})

export const MAX_ARTIFACTS_PER_PRESIGN = 200

export const artifactPresignItemSchema = z.object({
  executionIndex: z.number().int().nonnegative(),
  name: z.string().min(1),
  contentType: z.string().min(1),
  sizeBytes: z.number().int().nonnegative().max(MAX_ARTIFACT_BYTES),
})

export const artifactPresignRequestSchema = z.object({
  idempotencyKey: z.string().min(8).max(128),
  artifacts: z.array(artifactPresignItemSchema).min(1).max(MAX_ARTIFACTS_PER_PRESIGN),
})

export const artifactPresignItemResultSchema = z.object({
  executionIndex: z.number().int().nonnegative(),
  name: z.string().min(1),
  key: z.string().min(1),
  uploadUrl: z.string().min(1),
})

export const artifactPresignResponseSchema = z.object({
  items: z.array(artifactPresignItemResultSchema),
})

export const MAX_CODEOWNERS_BYTES = 200_000

export const codeownersUploadSchema = z.object({
  content: z.string().max(MAX_CODEOWNERS_BYTES),
})

export const quarantineSetSchema = z.object({
  decision: z
    .enum(['quarantined', 'released', 'auto'])
    .describe(
      'quarantined and released are a person deciding; auto returns the test to the scorer',
    ),
  reason: z.string().max(200).optional().describe('Why, shown beside the test'),
})

export type JunitIngestRequest = z.infer<typeof junitIngestSchema>
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
export type ArtifactPresignItem = z.infer<typeof artifactPresignItemSchema>
export type ArtifactPresignRequest = z.infer<typeof artifactPresignRequestSchema>
export type ArtifactPresignItemResult = z.infer<typeof artifactPresignItemResultSchema>
export type ArtifactPresignResponse = z.infer<typeof artifactPresignResponseSchema>
export type CodeownersUpload = z.infer<typeof codeownersUploadSchema>
export type QuarantineSetRequest = z.infer<typeof quarantineSetSchema>
