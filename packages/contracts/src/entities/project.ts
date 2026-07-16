import { z } from 'zod'

import { idSchema, timestampSchema } from '../common'

export const projectSchema = z.object({
  id: idSchema,
  orgId: idSchema,
  name: z.string().min(1),
  slug: z.string().min(1),
  defaultBranch: z.string().min(1),
  createdAt: timestampSchema,
})

export type Project = z.infer<typeof projectSchema>
