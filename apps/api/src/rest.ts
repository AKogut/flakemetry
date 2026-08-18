import { Readable } from 'node:stream'
import { createGzip } from 'node:zlib'

import {
  flakyBoardInputSchema,
  REST_ENDPOINTS,
  type RestAuth,
  type RestEndpoint,
  runsListInputSchema,
  testGetInputSchema,
  testHealthInputSchema,
} from '@flakemetry/contracts'
import type { PrismaClient } from '@flakemetry/db'
import {
  completeRequest,
  exportFilename,
  flakyBoard,
  getRca,
  getRun,
  getTest,
  getTestHealthMetrics,
  listRuns,
  startExportRecord,
  streamProjectExport,
} from '@flakemetry/queries'
import { type ObjectStore, projectArtifactPrefix } from '@flakemetry/storage'
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { zodToJsonSchema } from 'zod-to-json-schema'

import { type AuthenticatedProject, authenticateProject, hasScope } from './auth'
import type { RateLimiter } from './rate-limit'

export interface ReadApiDeps {
  prisma: PrismaClient
  limiter: RateLimiter
  store?: ObjectStore | null
}

export interface ReadContext {
  project: AuthenticatedProject
  request: FastifyRequest
  reply: FastifyReply
  prisma: PrismaClient
  store: ObjectStore | null
}

export interface ReadRoute {
  method: 'GET'
  path: string
  summary: string
  query?: { name: string; description: string }[]
  params?: { name: string; description: string }[]
  produces?: string
  handler: (context: ReadContext) => Promise<unknown>
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
    path: '/v1/export',
    summary: 'Every row this project holds, as a gzipped NDJSON archive',
    produces: 'application/gzip',
    handler: async ({ project, reply, prisma, store }) => {
      const record = await prisma.project.findUnique({
        where: { id: project.projectId },
        select: { slug: true, name: true },
      })
      if (!record) throw new NotFound('project not found')

      const exportedAt = new Date()
      const requestId = await startExportRecord(prisma, {
        orgId: project.orgId,
        projectId: project.projectId,
        subject: `project "${record.name}" (${record.slug})`,
        actor: `token:${project.tokenId}`,
        artifactPrefix: projectArtifactPrefix(project.orgId, project.projectId),
      })

      const lines = streamProjectExport(prisma, {
        projectId: project.projectId,
        exportedAt,
        artifacts: store
          ? { prefix: projectArtifactPrefix(project.orgId, project.projectId), store }
          : null,
        // Swallowed rather than propagated: the archive on the wire is already correct,
        // and failing a download because the bookkeeping update did not land would be the
        // audit trail taking the data with it.
        onComplete: (summary) =>
          completeRequest(prisma, requestId, {
            rowCount: summary.rows,
            artifactCount: summary.artifacts,
          }).catch(() => undefined),
      })

      // Served as a gzip file rather than a gzip content-encoding: the archive is meant to
      // be saved and kept, and a client that transparently inflates it hands the caller a
      // file whose name says .gz and whose bytes do not.
      const gzip = createGzip()
      Readable.from(lines).pipe(gzip)

      return reply
        .header('content-type', 'application/gzip')
        .header(
          'content-disposition',
          `attachment; filename="${exportFilename(record.slug, exportedAt)}"`,
        )
        .send(gzip)
    },
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

const SCOPE_NOTE: Record<RestAuth, string | null> = {
  none: null,
  'ingest-token': 'Needs a token carrying the "ingest" scope.',
  'read-token': 'Needs a token carrying the "read" scope.',
  'quarantine-token': 'Needs a token carrying the "quarantine" scope.',
  'any-token': 'Needs a project token carrying either the "ingest" or the "read" scope.',
}

const LEADING_STATUS = /^`(\d{3})`/

const successStatus = (response: string): number => {
  const match = LEADING_STATUS.exec(response.trim())
  return match ? Number(match[1]) : 200
}

const readRouteByPath = new Map(READ_ROUTES.map((route) => [route.path, route]))

const parametersFor = (endpoint: RestEndpoint): unknown[] => {
  const route = readRouteByPath.get(endpoint.path)
  const declared = [
    ...(route?.params ?? []).map((param) => ({ ...param, in: 'path', required: true })),
    ...(route?.query ?? []).map((param) => ({ ...param, in: 'query', required: false })),
  ]
  if (declared.length > 0) {
    return declared.map((param) => ({
      name: param.name,
      in: param.in,
      required: param.required,
      description: param.description,
      schema: { type: 'string' },
    }))
  }

  // Paths carrying a segment that no route table describes still have to declare it, or
  // the document is not a valid description of a URL a client can build.
  return [...endpoint.path.matchAll(/:(\w+)/g)].map((match) => ({
    name: match[1],
    in: 'path',
    required: true,
    schema: { type: 'string' },
  }))
}

/**
 * Generated from `REST_ENDPOINTS` — the same table the human reference is built from — so
 * the machine-readable description covers the whole surface rather than the read half.
 * It previously came from `READ_ROUTES`, which meant ingestion, the quality gate and
 * quarantine were invisible to anything generating a client, with nothing to say so.
 */
export const openApiDocument = (version: string): Record<string, unknown> => {
  const paths: Record<string, Record<string, unknown>> = {}

  for (const endpoint of REST_ENDPOINTS) {
    const path = endpoint.path.replace(/:(\w+)/g, '{$1}')
    const route = readRouteByPath.get(endpoint.path)
    const scopeNote = SCOPE_NOTE[endpoint.auth]

    const responses: Record<string, unknown> = {
      [successStatus(endpoint.response)]: {
        description: endpoint.response,
        ...(route?.produces ? { content: { [route.produces]: {} } } : {}),
      },
    }
    if (endpoint.auth !== 'none') {
      responses[401] = { description: 'Missing or invalid token' }
      responses[403] = { description: 'The token does not carry the required scope' }
      responses[429] = { description: 'Rate limited' }
    }

    paths[path] = {
      ...paths[path],
      [endpoint.method.toLowerCase()]: {
        summary: endpoint.summary,
        ...(scopeNote ? { description: scopeNote } : {}),
        security: endpoint.auth === 'none' ? [] : [{ bearerAuth: [] }],
        parameters: parametersFor(endpoint),
        ...(endpoint.request
          ? {
              requestBody: {
                required: true,
                content: {
                  'application/json': {
                    // Inlined rather than named: a `name` puts the schema under
                    // `definitions` and leaves a $ref pointing where OpenAPI does not
                    // look, so a generated client cannot resolve it.
                    schema: zodToJsonSchema(endpoint.request.schema, { $refStrategy: 'none' }),
                  },
                },
              },
            }
          : {}),
        responses,
      },
    }
  }

  return {
    openapi: '3.1.0',
    info: {
      title: 'Flakemetry API',
      version,
      description:
        'Ingestion, read and quarantine for a single project. Scopes are separate on purpose: a credential handed to a script cannot forge test data, one that reads cannot silence a failing test, and the one in every CI job carries neither.',
    },
    components: {
      securitySchemes: {
        bearerAuth: { type: 'http', scheme: 'bearer', description: 'A project token' },
      },
    },
    paths,
  }
}

export const registerReadApi = (app: FastifyInstance, deps: ReadApiDeps): void => {
  const { prisma, limiter } = deps
  const store = deps.store ?? null

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
        return await route.handler({ project, request, reply, prisma, store })
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
