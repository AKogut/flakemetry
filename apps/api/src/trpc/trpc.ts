import { initTRPC, TRPCError } from '@trpc/server'

import type { TrpcContext } from './context'

const t = initTRPC.context<TrpcContext>().create()

export const router = t.router

export const protectedProcedure = t.procedure.use(({ ctx, next }) => {
  if (!ctx.project) {
    throw new TRPCError({ code: 'UNAUTHORIZED', message: 'missing or invalid token' })
  }
  if (!ctx.limiter.check(ctx.project.projectId).allowed) {
    throw new TRPCError({ code: 'TOO_MANY_REQUESTS', message: 'rate limited' })
  }
  return next({ ctx: { ...ctx, project: ctx.project } })
})
