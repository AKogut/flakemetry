import { z } from 'zod'

import {
  ciProviderSchema,
  commitShaSchema,
  idSchema,
  runStatusSchema,
  testStatusSchema,
  timestampSchema,
} from './common'
import { reasonCodeSchema } from './entities/flaky-score'
import { rcaReportSchema } from './entities/rca-report'
import { artifactRefSchema } from './ingestion'

export const runCountsSchema = z.object({
  total: z.number().int().nonnegative(),
  passed: z.number().int().nonnegative(),
  failed: z.number().int().nonnegative(),
  skipped: z.number().int().nonnegative(),
  flaky: z.number().int().nonnegative(),
})

export const runListItemSchema = z.object({
  id: idSchema,
  branch: z.string(),
  commitSha: commitShaSchema,
  prNumber: z.number().int().positive().nullable(),
  ciProvider: ciProviderSchema,
  status: runStatusSchema,
  startedAt: timestampSchema,
  durationMs: z.number().int().nonnegative().nullable(),
  counts: runCountsSchema,
})

export const executionListItemSchema = z.object({
  id: idSchema,
  testIdentityId: idSchema,
  filePath: z.string(),
  suite: z.string(),
  title: z.string(),
  status: testStatusSchema,
  attempt: z.number().int().min(1),
  durationMs: z.number().int().nonnegative(),
  errorMessage: z.string().nullable(),
  hasRca: z.boolean(),
  artifacts: z.array(artifactRefSchema),
})

export const runDetailSchema = runListItemSchema.extend({
  trigger: z.string(),
  finishedAt: timestampSchema.nullable(),
  executions: z.array(executionListItemSchema),
})

export const testHistoryPointSchema = z.object({
  executionId: idSchema,
  runId: idSchema,
  commitSha: commitShaSchema,
  branch: z.string(),
  startedAt: timestampSchema,
  status: testStatusSchema,
  attempt: z.number().int().min(1),
  durationMs: z.number().int().nonnegative(),
  errorMessage: z.string().nullable(),
  hasRca: z.boolean(),
})

export const testDetailSchema = z.object({
  id: idSchema,
  fingerprint: z.string(),
  filePath: z.string(),
  suite: z.string(),
  title: z.string(),
  quarantined: z.boolean(),
  score: z.number().min(0).max(1).nullable(),
  reasonCodes: z.array(reasonCodeSchema),
  history: z.array(testHistoryPointSchema),
})

export const flakyTrendSchema = z.enum(['rising', 'falling', 'stable'])

export const flakyBoardItemSchema = z.object({
  testIdentityId: idSchema,
  filePath: z.string(),
  suite: z.string(),
  title: z.string(),
  score: z.number().min(0).max(1),
  flipRate: z.number().min(0).max(1),
  passOnRerunRate: z.number().min(0).max(1),
  trend: flakyTrendSchema,
  lastFlakedAt: timestampSchema.nullable(),
  quarantineCandidate: z.boolean(),
  quarantined: z.boolean(),
})

export const runsListInputSchema = z.object({
  branch: z.string().min(1).optional(),
  status: runStatusSchema.optional(),
  since: timestampSchema.optional(),
  until: timestampSchema.optional(),
  cursor: idSchema.optional(),
  limit: z.number().int().min(1).max(100).default(20),
})

export const runsListResultSchema = z.object({
  items: z.array(runListItemSchema),
  nextCursor: idSchema.nullable(),
})

export const runGetInputSchema = z.object({
  runId: idSchema,
})

export const testGetInputSchema = z.object({
  testIdentityId: idSchema,
  historyLimit: z.number().int().min(1).max(200).default(50),
})

export const flakyBoardInputSchema = z.object({
  limit: z.number().int().min(1).max(100).default(20),
  minScore: z.number().min(0).max(1).default(0),
  includeQuarantined: z.boolean().default(true),
})

export const flakyBoardResultSchema = z.object({
  items: z.array(flakyBoardItemSchema),
})

export const rcaGetInputSchema = z.object({
  executionId: idSchema,
})

export const rcaGetResultSchema = rcaReportSchema.nullable()

export type RunsListInput = z.infer<typeof runsListInputSchema>
export type RunsListResult = z.infer<typeof runsListResultSchema>
export type RunGetInput = z.infer<typeof runGetInputSchema>
export type TestGetInput = z.infer<typeof testGetInputSchema>
export type FlakyBoardInput = z.infer<typeof flakyBoardInputSchema>
export type FlakyBoardResult = z.infer<typeof flakyBoardResultSchema>
export type RcaGetInput = z.infer<typeof rcaGetInputSchema>
export type RcaGetResult = z.infer<typeof rcaGetResultSchema>
export type RunCounts = z.infer<typeof runCountsSchema>
export type RunListItem = z.infer<typeof runListItemSchema>
export type ExecutionListItem = z.infer<typeof executionListItemSchema>
export type RunDetail = z.infer<typeof runDetailSchema>
export type TestHistoryPoint = z.infer<typeof testHistoryPointSchema>
export type TestDetail = z.infer<typeof testDetailSchema>
export type FlakyTrend = z.infer<typeof flakyTrendSchema>
export type FlakyBoardItem = z.infer<typeof flakyBoardItemSchema>
