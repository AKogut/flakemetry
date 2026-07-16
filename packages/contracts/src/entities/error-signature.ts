import { z } from 'zod'

import { idSchema, timestampSchema } from '../common'

export const errorSignatureSchema = z.object({
  id: idSchema,
  projectId: idSchema,
  normalizedHash: z.string().min(1),
  sampleMessage: z.string(),
  stackTemplate: z.string(),
  clusterId: idSchema.nullable(),
  occurrenceCount: z.number().int().positive(),
  knownIssueRef: z.string().nullable(),
  firstSeenAt: timestampSchema,
  lastSeenAt: timestampSchema,
})

export type ErrorSignature = z.infer<typeof errorSignatureSchema>
