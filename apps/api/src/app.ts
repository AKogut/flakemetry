import { ingestRunBatchSchema } from '@flakemetry/contracts'
import { IngestionQueue, type PrismaClient } from '@flakemetry/db'
import Fastify, { type FastifyInstance } from 'fastify'

import { authenticateProject } from './auth'

export interface AppOptions {
  prisma: PrismaClient
  queue?: IngestionQueue
  bodyLimitBytes?: number
}

export const buildApp = (options: AppOptions): FastifyInstance => {
  const { prisma } = options
  const queue = options.queue ?? new IngestionQueue(prisma)
  const app = Fastify({
    logger: false,
    bodyLimit: options.bodyLimitBytes ?? 8 * 1024 * 1024,
  })

  app.get('/health', async () => ({ status: 'ok', service: 'api' }))

  app.post('/v1/ingest', async (request, reply) => {
    const project = await authenticateProject(prisma, request)
    if (!project) {
      return reply.code(401).send({ error: 'unauthorized', message: 'missing or invalid token' })
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

    return reply.code(202).send({
      receiptId: jobId,
      acceptedExecutions: batch.executions.length,
      deduplicated,
    })
  })

  return app
}
