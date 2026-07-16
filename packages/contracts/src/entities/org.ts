import { z } from 'zod'

import { idSchema, timestampSchema } from '../common'

export const orgSchema = z.object({
  id: idSchema,
  name: z.string().min(1),
  slug: z.string().min(1),
  createdAt: timestampSchema,
})

export type Org = z.infer<typeof orgSchema>
