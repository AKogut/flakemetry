import {
  flakyBoardInputSchema,
  rcaGetInputSchema,
  runGetInputSchema,
  runsListInputSchema,
  testGetInputSchema,
} from '@flakemetry/contracts'
import { TRPCError } from '@trpc/server'

import { flakyBoard } from '../queries/flaky'
import { getRca } from '../queries/rca'
import { getRun, listRuns } from '../queries/runs'
import { getTest } from '../queries/tests'
import { protectedProcedure, router } from './trpc'

export const appRouter = router({
  runs: router({
    list: protectedProcedure
      .input(runsListInputSchema)
      .query(({ ctx, input }) => listRuns(ctx.prisma, ctx.project.projectId, input)),
  }),

  run: router({
    get: protectedProcedure.input(runGetInputSchema).query(async ({ ctx, input }) => {
      const run = await getRun(ctx.prisma, ctx.project.projectId, input.runId)
      if (!run) throw new TRPCError({ code: 'NOT_FOUND', message: 'run not found' })
      return run
    }),
  }),

  test: router({
    get: protectedProcedure.input(testGetInputSchema).query(async ({ ctx, input }) => {
      const test = await getTest(
        ctx.prisma,
        ctx.project.projectId,
        input.testIdentityId,
        input.historyLimit,
      )
      if (!test) throw new TRPCError({ code: 'NOT_FOUND', message: 'test not found' })
      return test
    }),
  }),

  flaky: router({
    board: protectedProcedure
      .input(flakyBoardInputSchema)
      .query(({ ctx, input }) => flakyBoard(ctx.prisma, ctx.project.projectId, input)),
  }),

  rca: router({
    get: protectedProcedure
      .input(rcaGetInputSchema)
      .query(({ ctx, input }) => getRca(ctx.prisma, ctx.project.projectId, input.executionId)),
  }),
})

export type AppRouter = typeof appRouter
