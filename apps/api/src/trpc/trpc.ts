import { initTRPC, TRPCError } from '@trpc/server'

import type { TrpcContext } from './context'

const t = initTRPC.context<TrpcContext>().create()

export const router = t.router
export const publicProcedure = t.procedure

export const protectedProcedure = t.procedure.use(({ ctx, next }) => {
  if (!ctx.project) {
    throw new TRPCError({ code: 'UNAUTHORIZED', message: 'missing or invalid token' })
  }
  return next({ ctx: { ...ctx, project: ctx.project } })
})
