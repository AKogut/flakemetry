import type { PrismaClient } from '@flakemetry/db'
import type { CreateFastifyContextOptions } from '@trpc/server/adapters/fastify'

import { type AuthenticatedProject, authenticateProject } from '../auth'

export interface TrpcContext {
  prisma: PrismaClient
  project: AuthenticatedProject | null
}

export const createContextFactory =
  (prisma: PrismaClient) =>
  async ({ req }: CreateFastifyContextOptions): Promise<TrpcContext> => ({
    prisma,
    project: await authenticateProject(prisma, req),
  })
