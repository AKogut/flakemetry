import { z } from 'zod'

import { idSchema, semverSchema, timestampSchema } from '../common'

export const reasonCodeSchema = z.object({
  code: z.string().min(1),
  message: z.string().min(1),
})

export const flakyScoreSchema = z.object({
  testIdentityId: idSchema,
  projectId: idSchema,
  score: z.number().min(0).max(1),
  flipRate: z.number().min(0).max(1),
  passOnRerunRate: z.number().min(0).max(1),
  sameShaVariance: z.number().min(0).max(1),
  entropy: z.number().min(0),
  failIsolation: z.number().min(0).max(1),
  reasonCodes: z.array(reasonCodeSchema),
  quarantineCandidate: z.boolean(),
  lastFlakedAt: timestampSchema.nullable(),
  modelVersion: semverSchema,
  updatedAt: timestampSchema,
})

export type ReasonCode = z.infer<typeof reasonCodeSchema>
export type FlakyScore = z.infer<typeof flakyScoreSchema>
