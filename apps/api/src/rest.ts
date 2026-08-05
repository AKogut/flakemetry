import {
  flakyBoardInputSchema,
  runsListInputSchema,
  testGetInputSchema,
  testHealthInputSchema,
} from '@flakemetry/contracts'
import type { PrismaClient } from '@flakemetry/db'
import {
  flakyBoard,
  getRca,
  getRun,
  getTest,
  getTestHealthMetrics,
  listRuns,
} from '@flakemetry/queries'
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'

import { type AuthenticatedProject, authenticateProject, hasScope } from './auth'
import type { RateLimiter } from './rate-limit'

export interface ReadApiDeps {
  prisma: PrismaClient
  limiter: RateLimiter
}

export interface ReadRoute {
  method: 'GET'
  path: string
  summary: string
  query?: { name: string; description: string }[]
  params?: { name: string; description: string }[]
  handler: (context: {
    project: AuthenticatedProject
    request: FastifyRequest
    prisma: PrismaClient
  }) => Promise<unknown>
}

/**
 * Query strings arrive as strings; the contracts that already describe these inputs expect
 * numbers and booleans. Coercing here keeps one definition of what an input is rather than a
 * second, subtly different one for HTTP.
 */
const coerce = (raw: Record<string, string | undefined>): Record<string, unknown> => {
  const out: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(raw)) {
    if (value === undefined || value === '') continue
    if (value === 'true' || value === 'false') {
      out[key] = value === 'true'
      continue
    }
    const asNumber = Number(value)
    out[key] = value.trim() !== '' && Number.isFinite(asNumber) ? asNumber : value
  }
  return out
}

const queryOf = (request: FastifyRequest): Record<string, unknown> =>
  coerce(request.query as Record<string, string | undefined>)

const paramOf = (request: FastifyRequest, name: string): string =>
  String((request.params as Record<string, string>)[name] ?? '')

export class NotFound extends Error {}

/**
 * The routes are data so the OpenAPI document below is generated from the same table that
 * registers them. A specification maintained beside its implementation drifts from it, and a
 * drifted specification is worse than none — it is wrong with authority.
 */
export const READ_ROUTES: ReadRoute[] = [
  {
    method: 'GET',
    path: '/v1/runs',
    summary: 'List runs, newest first',
    query: [
      { name: 'limit', description: 'Page size, 1-100 (default 20)' },
      { name: 'cursor', description: 'nextCursor from the previous page' },
      { name: 'branch', description: 'Restrict to one branch' },
      { name: 'status', description: 'passed, failed, running or canceled' },
      { name: 'since', description: 'ISO timestamp lower bound' },
      { name: 'until', description: 'ISO timestamp upper bound' },
    ],
    handler: async ({ project, request, prisma }) =>
      listRuns(prisma, project.projectId, runsListInputSchema.parse(queryOf(request))),
  },
  {
    method: 'GET',
    path: '/v1/runs/:runId',
    summary: 'One run with its counts',
    params: [{ name: 'runId', description: 'Run id' }],
    handler: async ({ project, request, prisma }) => {
      const run = await getRun(prisma, project.projectId, paramOf(request, 'runId'))
      if (!run) throw new NotFound('run not found')
      return run
    },
  },
  {
    method: 'GET',
    path: '/v1/tests/:testIdentityId',
    summary: 'One test identity with its recent history',
    params: [{ name: 'testIdentityId', description: 'Test identity id' }],
    query: [{ name: 'historyLimit', description: 'Executions to include, 1-200 (default 50)' }],
    handler: async ({ project, request, prisma }) => {
      const input = testGetInputSchema.parse({
        ...queryOf(request),
        testIdentityId: paramOf(request, 'testIdentityId'),
      })
      const test = await getTest(
        prisma,
        project.projectId,
        input.testIdentityId,
        input.historyLimit,
      )
      if (!test) throw new NotFound('test not found')
      return test
    },
  },
  {
    method: 'GET',
    path: '/v1/flaky',
    summary: 'The flaky board: scored tests, worst first',
    query: [
      { name: 'limit', description: 'Page size, 1-100 (default 20)' },
      { name: 'minScore', description: 'Only tests at or above this score' },
      { name: 'includeQuarantined', description: 'true or false (default true)' },
      { name: 'owner', description: 'Restrict to a CODEOWNERS owner' },
    ],
    handler: async ({ project, request, prisma }) =>
      flakyBoard(prisma, project.projectId, flakyBoardInputSchema.parse(queryOf(request))),
  },
  {
    method: 'GET',
    path: '/v1/executions/:executionId/rca',
    summary: 'The root-cause analysis for one execution, when there is one',
    params: [{ name: 'executionId', description: 'Execution id' }],
    handler: async ({ project, request, prisma }) =>
      getRca(prisma, project.projectId, paramOf(request, 'executionId')),
  },
  {
    method: 'GET',
    path: '/v1/health',
    summary: 'Project health metrics over a window',
    query: [
      { name: 'days', description: 'Window in days, 1-365 (default 90)' },
      { name: 'owner', description: 'Restrict to a CODEOWNERS owner' },
    ],
    handler: async ({ project, request, prisma }) => {
      const input = testHealthInputSchema.parse(queryOf(request))
      return getTestHealthMetrics(prisma, project.projectId, input.days, input.owner)
    },
  },
]

export const openApiDocument = (version: string): Record<string, unknown> => {
  const paths: Record<string, unknown> = {}

  for (const route of READ_ROUTES) {
    const path = route.path.replace(/:(\w+)/g, '{$1}')
    paths[path] = {
      get: {
        summary: route.summary,
        security: [{ bearerAuth: [] }],
        parameters: [
          ...(route.params ?? []).map((param) => ({
            name: param.name,
            in: 'path',
            required: true,
            description: param.description,
            schema: { type: 'string' },
          })),
          ...(route.query ?? []).map((param) => ({
            name: param.name,
            in: 'query',
            required: false,
            description: param.description,
            schema: { type: 'string' },
          })),
        ],
        responses: {
          200: { description: 'Success' },
          401: { description: 'Missing or invalid token' },
          403: { description: 'The token does not carry the read scope' },
          404: { description: 'Not found' },
          429: { description: 'Rate limited' },
        },
      },
    }
  }

  return {
    openapi: '3.1.0',
    info: {
      title: 'Flakemetry read API',
      version,
      description:
        'Read-only access to a single project. Authorise with a token carrying the "read" scope; an ingest token will not do, so a credential handed to a script cannot forge test data.',
    },
    components: {
      securitySchemes: {
        bearerAuth: { type: 'http', scheme: 'bearer', description: 'A project token' },
      },
    },
    security: [{ bearerAuth: [] }],
    paths,
  }
}

export const registerReadApi = (app: FastifyInstance, deps: ReadApiDeps): void => {
  const { prisma, limiter } = deps

  const authorise = async (
    request: FastifyRequest,
    reply: FastifyReply,
  ): Promise<AuthenticatedProject | null> => {
    const project = await authenticateProject(prisma, request)
    if (!project) {
      void reply.code(401).send({ error: 'unauthorized', message: 'missing or invalid token' })
      return null
    }
    if (!hasScope(project, 'read')) {
      void reply.code(403).send({
        error: 'insufficient_scope',
        message: 'this endpoint needs a token with the "read" scope',
      })
      return null
    }
    if (!limiter.check(project.projectId).allowed) {
      void reply.code(429).send({ error: 'rate_limited' })
      return null
    }
    return project
  }

  for (const route of READ_ROUTES) {
    app.get(route.path, async (request, reply) => {
      const project = await authorise(request, reply)
      if (!project) return reply

      try {
        return await route.handler({ project, request, prisma })
      } catch (error) {
        if (error instanceof NotFound) {
          return reply.code(404).send({ error: 'not_found', message: error.message })
        }
        if (error instanceof Error && error.name === 'ZodError') {
          return reply.code(400).send({ error: 'invalid_query', message: error.message })
        }
        throw error
      }
    })
  }

  app.get('/openapi.json', async (_request, reply) => {
    reply.header('cache-control', 'public, max-age=300')
    return openApiDocument(process.env.npm_package_version ?? '0.1.0')
  })
}
