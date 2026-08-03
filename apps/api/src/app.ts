import { Transform } from 'node:stream'
import { createGunzip } from 'node:zlib'

import {
  artifactPresignRequestSchema,
  codeownersUploadSchema,
  ingestRunBatchSchema,
  isAllowedArtifactContentType,
  junitIngestSchema,
  junitToIngestBatch,
  notificationRoutingSchema,
  otlpToIngestBatch,
  otlpTraceRequestSchema,
  parseJunitXml,
} from '@flakemetry/contracts'
import { IngestionQueue, type PrismaClient } from '@flakemetry/db'
import {
  type GateStrictness,
  getPrGate,
  getRunSummaryByCommit,
  renderGateComment,
  renderPrComment,
} from '@flakemetry/queries'
import { artifactKey, type ObjectStore } from '@flakemetry/storage'
import { fastifyTRPCPlugin } from '@trpc/server/adapters/fastify'
import Fastify, {
  type FastifyInstance,
  type FastifyReply,
  type FastifyServerOptions,
} from 'fastify'

import { authenticateProject } from './auth'
import { createRateLimiter } from './rate-limit'
import { apiMetrics } from './telemetry'
import { createContextFactory } from './trpc/context'
import { appRouter } from './trpc/router'

export interface AppOptions {
  prisma: PrismaClient
  queue?: IngestionQueue
  store?: ObjectStore | null
  bodyLimitBytes?: number
  maxDecompressedBytes?: number
  logger?: FastifyServerOptions['logger']
  maxQueueDepth?: number
  depthCacheMs?: number
  rateLimit?: { max: number; windowMs: number }
  rateLimitNow?: () => number
  now?: () => number
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

  const now = options.now ?? (() => Date.now())
  const depthCacheMs = options.depthCacheMs ?? 1_000
  let cachedDepth = 0
  let depthReadAt = -Infinity

  const queueDepth = async (): Promise<number> => {
    const at = now()
    if (at - depthReadAt < depthCacheMs) return cachedDepth
    cachedDepth = await queue.depth()
    depthReadAt = at
    return cachedDepth
  }

  const maxDecompressedBytes = options.maxDecompressedBytes ?? 16 * 1024 * 1024

  app.addHook('onRequest', async (_request, reply) => {
    reply.header('x-content-type-options', 'nosniff')
    reply.header('x-frame-options', 'DENY')
    reply.header('referrer-policy', 'no-referrer')
    reply.header('cross-origin-resource-policy', 'same-origin')
    reply.header('cache-control', 'no-store')
    if (process.env.NODE_ENV === 'production') {
      reply.header('strict-transport-security', 'max-age=63072000; includeSubDomains')
    }
  })

  app.addHook('preParsing', async (request, _reply, payload) => {
    if (request.headers['content-encoding'] !== 'gzip') return payload
    delete request.headers['content-encoding']
    delete request.headers['content-length']
    const gunzip = createGunzip()
    let total = 0
    const cap = new Transform({
      transform(chunk: Buffer, _encoding, callback) {
        total += chunk.length
        if (total > maxDecompressedBytes) {
          callback(new Error('decompressed body exceeds limit'))
          return
        }
        callback(null, chunk)
      },
    })
    payload.on('error', (error) => gunzip.destroy(error))
    gunzip.on('error', (error) => cap.destroy(error))
    payload.pipe(gunzip).pipe(cap)
    return cap
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
    if (options.maxQueueDepth != null && (await queueDepth()) >= options.maxQueueDepth) {
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
    trpcOptions: { router: appRouter, createContext: createContextFactory(prisma, limiter) },
  })

  const rateLimited = (projectId: string, reply: FastifyReply): boolean => {
    const decision = limiter.check(projectId)
    if (decision.allowed) return false
    apiMetrics.rateLimited.add(1)
    setRetryAfter(reply, decision.retryAfterMs)
    return true
  }

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

  app.post('/v1/ingest/junit', async (request, reply) => {
    const project = await authenticateProject(prisma, request)
    if (!project) {
      return reply.code(401).send({ error: 'unauthorized', message: 'missing or invalid token' })
    }

    const admission = await admit(project.projectId)
    if (!admission.ok) {
      setRetryAfter(reply, admission.retryAfterMs)
      return reply.code(admission.status).send({ error: admission.reason })
    }

    const parsed = junitIngestSchema.safeParse(request.body)
    if (!parsed.success) {
      return reply.code(400).send({
        error: 'invalid_payload',
        issues: parsed.error.issues.map((issue) => ({
          path: issue.path.join('.'),
          message: issue.message,
        })),
      })
    }

    let junit
    try {
      junit = parseJunitXml(parsed.data.xml)
    } catch (error) {
      return reply.code(400).send({
        error: 'invalid_junit_xml',
        message: error instanceof Error ? error.message : 'could not parse the report',
      })
    }

    if (junit.executions.length === 0) {
      return reply.code(400).send({
        error: 'empty_report',
        message: 'the report contains no test cases',
      })
    }

    const batch = junitToIngestBatch(junit, {
      idempotencyKey: parsed.data.idempotencyKey,
      resource: parsed.data.resource,
    })

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

  app.post('/v1/artifacts/presign', async (request, reply) => {
    const project = await authenticateProject(prisma, request)
    if (!project) {
      return reply.code(401).send({ error: 'unauthorized', message: 'missing or invalid token' })
    }

    if (rateLimited(project.projectId, reply)) {
      return reply.code(429).send({ error: 'rate_limited' })
    }

    const store = options.store
    if (!store) {
      return reply.code(501).send({ error: 'artifacts_disabled' })
    }

    const parsed = artifactPresignRequestSchema.safeParse(request.body)
    if (!parsed.success) {
      return reply.code(400).send({
        error: 'invalid_payload',
        issues: parsed.error.issues.map((issue) => ({
          path: issue.path.join('.'),
          message: issue.message,
        })),
      })
    }

    const rejected = parsed.data.artifacts.find(
      (artifact) => !isAllowedArtifactContentType(artifact.contentType),
    )
    if (rejected) {
      return reply
        .code(415)
        .send({ error: 'unsupported_content_type', contentType: rejected.contentType })
    }

    const items = await Promise.all(
      parsed.data.artifacts.map(async (artifact) => {
        const key = artifactKey({
          orgId: project.orgId,
          projectId: project.projectId,
          idempotencyKey: parsed.data.idempotencyKey,
          executionIndex: artifact.executionIndex,
          name: artifact.name,
        })
        return {
          executionIndex: artifact.executionIndex,
          name: artifact.name,
          key,
          uploadUrl: await store.presignUpload(key, artifact.contentType, {
            contentLength: artifact.sizeBytes,
          }),
        }
      }),
    )

    return reply.code(200).send({ items })
  })

  app.get('/v1/runs/summary', async (request, reply) => {
    const project = await authenticateProject(prisma, request)
    if (!project) {
      return reply.code(401).send({ error: 'unauthorized', message: 'missing or invalid token' })
    }

    if (rateLimited(project.projectId, reply)) {
      return reply.code(429).send({ error: 'rate_limited' })
    }

    const commitSha = (request.query as { commitSha?: string }).commitSha
    if (!commitSha || !/^[0-9a-f]{7,40}$/i.test(commitSha)) {
      return reply.code(400).send({ error: 'invalid_commit_sha' })
    }

    const summary = await getRunSummaryByCommit(prisma, project.projectId, commitSha)
    if (!summary) return reply.code(200).send({ found: false })

    return reply.code(200).send({ found: true, summary, markdown: renderPrComment(summary) })
  })

  app.put('/v1/codeowners', async (request, reply) => {
    const project = await authenticateProject(prisma, request)
    if (!project) {
      return reply.code(401).send({ error: 'unauthorized', message: 'missing or invalid token' })
    }

    if (rateLimited(project.projectId, reply)) {
      return reply.code(429).send({ error: 'rate_limited' })
    }

    const parsed = codeownersUploadSchema.safeParse(request.body)
    if (!parsed.success) {
      return reply.code(400).send({ error: 'invalid_payload' })
    }

    const content = parsed.data.content.trim()
    await prisma.project.update({
      where: { id: project.projectId },
      data: { codeowners: content.length > 0 ? content : null },
    })

    return reply.code(200).send({ ok: true })
  })

  app.put('/v1/notifications/routing', async (request, reply) => {
    const project = await authenticateProject(prisma, request)
    if (!project) {
      return reply.code(401).send({ error: 'unauthorized', message: 'missing or invalid token' })
    }

    if (rateLimited(project.projectId, reply)) {
      return reply.code(429).send({ error: 'rate_limited' })
    }

    const parsed = notificationRoutingSchema.safeParse(request.body)
    if (!parsed.success) {
      return reply.code(400).send({ error: 'invalid_payload' })
    }

    await prisma.$transaction([
      prisma.notificationChannel.deleteMany({
        where: { projectId: project.projectId, source: 'config' },
      }),
      prisma.notificationChannel.createMany({
        data: parsed.data.channels.map((channel) => ({
          orgId: project.orgId,
          projectId: project.projectId,
          kind: channel.kind,
          target: channel.target,
          events: channel.events,
          source: 'config',
        })),
      }),
    ])

    return reply.code(200).send({ ok: true, channels: parsed.data.channels.length })
  })

  app.get('/v1/runs/gate', async (request, reply) => {
    const project = await authenticateProject(prisma, request)
    if (!project) {
      return reply.code(401).send({ error: 'unauthorized', message: 'missing or invalid token' })
    }

    if (rateLimited(project.projectId, reply)) {
      return reply.code(429).send({ error: 'rate_limited' })
    }

    const query = request.query as { commitSha?: string; baseBranch?: string; strictness?: string }
    if (!query.commitSha || !/^[0-9a-f]{7,40}$/i.test(query.commitSha)) {
      return reply.code(400).send({ error: 'invalid_commit_sha' })
    }
    if (!query.baseBranch || !/^[\w./-]{1,255}$/.test(query.baseBranch)) {
      return reply.code(400).send({ error: 'invalid_base_branch' })
    }
    const strictnessValues: GateStrictness[] = ['off', 'new', 'any']
    const strictness = strictnessValues.includes(query.strictness as GateStrictness)
      ? (query.strictness as GateStrictness)
      : 'new'

    const gate = await getPrGate(prisma, project.projectId, query.commitSha, {
      baseBranch: query.baseBranch,
      strictness,
    })
    if (!gate) return reply.code(200).send({ found: false })

    return reply.code(200).send({ found: true, gate, markdown: renderGateComment(gate) })
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
