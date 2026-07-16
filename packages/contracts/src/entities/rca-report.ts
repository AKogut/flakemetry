import { z } from 'zod'

import { idSchema, timestampSchema } from '../common'

export const rcaSimilarPastSchema = z.object({
  signatureId: idSchema,
  summary: z.string(),
  resolution: z.string().nullable(),
})

export const rcaReportSchema = z.object({
  id: idSchema,
  projectId: idSchema,
  executionId: idSchema,
  signatureId: idSchema,
  summary: z.string().min(1),
  likelyCause: z.string().min(1),
  suggestedAction: z.string().min(1),
  confidence: z.number().min(0).max(1),
  similarPast: z.array(rcaSimilarPastSchema),
  llmModel: z.string().min(1),
  tokenCost: z.number().int().nonnegative(),
  createdAt: timestampSchema,
})

export type RcaSimilarPast = z.infer<typeof rcaSimilarPastSchema>
export type RcaReport = z.infer<typeof rcaReportSchema>
