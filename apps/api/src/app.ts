import { createGunzip } from 'node:zlib'

import {
  ingestRunBatchSchema,
  otlpToIngestBatch,
  otlpTraceRequestSchema,
} from '@flakemetry/contracts'
import { IngestionQueue, type PrismaClient } from '@flakemetry/db'
import { fastifyTRPCPlugin } from '@trpc/server/adapters/fastify'
import Fastify, {
  type FastifyInstance,
  type FastifyReply,
  type FastifyServerOptions,
} from 'fastify'

import { authenticateProject } from './auth'
import { createRateLimiter } from './rate-limit'
import { apiMetrics, observeQueueDepth } from './telemetry'
import { createContextFactory } from './trpc/context'
import { appRouter } from './trpc/router'

export interface AppOptions {
  prisma: PrismaClient
  queue?: IngestionQueue
  bodyLimitBytes?: number
  logger?: FastifyServerOptions['logger']
  maxQueueDepth?: number
  rateLimit?: { max: number; windowMs: number }
  rateLimitNow?: () => number
}

type Admission = { ok: true } | { ok: false; status: number; reason: string; retryAfterMs: number }

export const buildApp = (options: AppOptions): FastifyInstance => {
  const { prisma } = options
  const queue = options.queue ?? new IngestionQueue(prisma)
  const app = Fastify({
    logger: options.logger ?? false,
    bodyLimit: options.bodyLimitBytes ?? 8 * 1024 * 1024,
  })

  const limiter = createRateLimiter({
    max: options.rateLimit?.max ?? 600,
    windowMs: options.rateLimit?.windowMs ?? 60_000,
    now: options.rateLimitNow,
  })

  observeQueueDepth(() => queue.depth())

  app.addHook('preParsing', async (request, _reply, payload) => {
    if (request.headers['content-encoding'] !== 'gzip') return payload
    delete request.headers['content-encoding']
    delete request.headers['content-length']
    return payload.pipe(createGunzip())
  })

  app.addHook('onResponse', async (request, reply) => {
    apiMetrics.requestDuration.record(reply.elapsedTime, {
      route: request.routeOptions.url ?? request.url,
      status: reply.statusCode,
    })
  })

  const admit = async (projectId: string): Promise<Admission> => {
    const decision = limiter.check(projectId)
    if (!decision.allowed) {
      apiMetrics.rateLimited.add(1)
      return { ok: false, status: 429, reason: 'rate_limited', retryAfterMs: decision.retryAfterMs }
    }
    if (options.maxQueueDepth != null && (await queue.depth()) >= options.maxQueueDepth) {
      apiMetrics.backpressured.add(1)
      return { ok: false, status: 503, reason: 'backpressure', retryAfterMs: 1_000 }
    }
    return { ok: true }
  }

  const setRetryAfter = (reply: FastifyReply, ms: number): void => {
    reply.header('retry-after', Math.max(1, Math.ceil(ms / 1_000)))
  }

  app.get('/health', async () => ({ status: 'ok', service: 'api' }))

  void app.register(fastifyTRPCPlugin, {
    prefix: '/trpc',
    trpcOptions: { router: appRouter, createContext: createContextFactory(prisma) },
  })

  app.post('/v1/ingest', async (request, reply) => {
    const project = await authenticateProject(prisma, request)
    if (!project) {
      return reply.code(401).send({ error: 'unauthorized', message: 'missing or invalid token' })
    }

    const admission = await admit(project.projectId)
    if (!admission.ok) {
      setRetryAfter(reply, admission.retryAfterMs)
      return reply.code(admission.status).send({ error: admission.reason })
    }

    const parsed = ingestRunBatchSchema.safeParse(request.body)
    if (!parsed.success) {
      return reply.code(400).send({
        error: 'invalid_payload',
        issues: parsed.error.issues.map((issue) => ({
          path: issue.path.join('.'),
          message: issue.message,
        })),
      })
    }

    const batch = parsed.data
    const { jobId, deduplicated } = await queue.enqueue({
      orgId: project.orgId,
      projectId: project.projectId,
      idempotencyKey: batch.idempotencyKey,
      payload: JSON.parse(JSON.stringify(batch)),
    })

    apiMetrics.runsAccepted.add(1)
    apiMetrics.executionsAccepted.add(batch.executions.length)

    return reply.code(202).send({
      receiptId: jobId,
      acceptedExecutions: batch.executions.length,
      deduplicated,
    })
  })

  app.post('/v1/traces', async (request, reply) => {
    const project = await authenticateProject(prisma, request)
    if (!project) {
      return reply.code(401).send({ error: 'unauthorized', message: 'missing or invalid token' })
    }

    const admission = await admit(project.projectId)
    if (!admission.ok) {
      setRetryAfter(reply, admission.retryAfterMs)
      return reply
        .code(admission.status)
        .send({ partialSuccess: { rejectedSpans: '0', errorMessage: admission.reason } })
    }

    const parsedRequest = otlpTraceRequestSchema.safeParse(request.body)
    if (!parsedRequest.success) {
      return reply.code(400).send({
        partialSuccess: { rejectedSpans: '0', errorMessage: 'malformed OTLP payload' },
      })
    }

    let batch
    try {
      batch = ingestRunBatchSchema.parse(otlpToIngestBatch(parsedRequest.data))
    } catch (error) {
      return reply.code(400).send({
        partialSuccess: {
          rejectedSpans: '0',
          errorMessage: error instanceof Error ? error.message : 'unmappable OTLP payload',
        },
      })
    }

    await queue.enqueue({
      orgId: project.orgId,
      projectId: project.projectId,
      idempotencyKey: batch.idempotencyKey,
      payload: JSON.parse(JSON.stringify(batch)),
    })

    apiMetrics.runsAccepted.add(1)
    apiMetrics.executionsAccepted.add(batch.executions.length)

    return reply.code(200).send({})
  })

  return app
}

export type { AppRouter } from './trpc/router'
