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
})

export const runDetailSchema = runListItemSchema.extend({
  trigger: z.string(),
  finishedAt: timestampSchema.nullable(),
  executions: z.array(executionListItemSchema),
})

export const testHistoryPointSchema = z.object({
  runId: idSchema,
  commitSha: commitShaSchema,
  startedAt: timestampSchema,
  status: testStatusSchema,
  durationMs: z.number().int().nonnegative(),
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

export type RunCounts = z.infer<typeof runCountsSchema>
export type RunListItem = z.infer<typeof runListItemSchema>
export type ExecutionListItem = z.infer<typeof executionListItemSchema>
export type RunDetail = z.infer<typeof runDetailSchema>
export type TestHistoryPoint = z.infer<typeof testHistoryPointSchema>
export type TestDetail = z.infer<typeof testDetailSchema>
export type FlakyTrend = z.infer<typeof flakyTrendSchema>
export type FlakyBoardItem = z.infer<typeof flakyBoardItemSchema>
