import { z } from 'zod'

import { fingerprintSchema, idSchema, timestampSchema } from '../common'

export const testIdentitySchema = z.object({
  id: idSchema,
  projectId: idSchema,
  fingerprint: fingerprintSchema,
  filePath: z.string().min(1),
  suite: z.string(),
  title: z.string().min(1),
  paramsHash: z.string().nullable(),
  aliases: z.array(fingerprintSchema),
  quarantined: z.boolean(),
  quarantineReason: z.string().nullable(),
  firstSeenAt: timestampSchema,
  lastSeenAt: timestampSchema,
})

export type TestIdentity = z.infer<typeof testIdentitySchema>
