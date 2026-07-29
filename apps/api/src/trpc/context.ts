import type { PrismaClient } from '@flakemetry/db'
import type { CreateFastifyContextOptions } from '@trpc/server/adapters/fastify'

import { type AuthenticatedProject, authenticateProject } from '../auth'
import type { RateLimiter } from '../rate-limit'

export interface TrpcContext {
  prisma: PrismaClient
  project: AuthenticatedProject | null
  limiter: RateLimiter
}

export const createContextFactory =
  (prisma: PrismaClient, limiter: RateLimiter) =>
  async ({ req }: CreateFastifyContextOptions): Promise<TrpcContext> => ({
    prisma,
    project: await authenticateProject(prisma, req),
    limiter,
  })
