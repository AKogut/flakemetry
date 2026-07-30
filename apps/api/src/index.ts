import { getPrismaClient, IngestionQueue } from '@flakemetry/db'
import { resolveObjectStore } from '@flakemetry/storage'

import { buildApp } from './app'
import { initSelfTelemetry, observeQueueDepth } from './telemetry'

export type { AppRouter } from './app'

const port = Number(process.env.PORT ?? 4000)
const host = process.env.HOST ?? '0.0.0.0'

const selfOtelEndpoint = process.env.FLAKEMETRY_SELF_OTEL_ENDPOINT
const shutdownTelemetry = selfOtelEndpoint
  ? initSelfTelemetry({ endpoint: selfOtelEndpoint })
  : undefined

const DEFAULT_MAX_QUEUE_DEPTH = 10_000
const configuredMaxQueueDepth = process.env.FLAKEMETRY_MAX_QUEUE_DEPTH
const parsedMaxQueueDepth =
  configuredMaxQueueDepth == null || configuredMaxQueueDepth === ''
    ? DEFAULT_MAX_QUEUE_DEPTH
    : Number(configuredMaxQueueDepth)
const maxQueueDepth =
  Number.isFinite(parsedMaxQueueDepth) && parsedMaxQueueDepth > 0 ? parsedMaxQueueDepth : undefined

const prisma = getPrismaClient()
const queue = new IngestionQueue(prisma)

observeQueueDepth(() => queue.depth())

const app = buildApp({
  prisma,
  queue,
  store: resolveObjectStore(process.env),
  logger: {
    level: process.env.LOG_LEVEL ?? 'info',
    redact: ['req.headers.authorization'],
  },
  maxQueueDepth,
})

let shuttingDown = false
const shutdown = async (): Promise<void> => {
  if (shuttingDown) return
  shuttingDown = true
  process.stdout.write('api: shutting down\n')
  await app.close().catch(() => {})
  await shutdownTelemetry?.()
  await prisma.$disconnect().catch(() => {})
  process.exit(0)
}
process.on('SIGINT', () => void shutdown())
process.on('SIGTERM', () => void shutdown())

app
  .listen({ port, host })
  .then((address: string) => {
    process.stdout.write(`api listening on ${address}\n`)
  })
  .catch((error: unknown) => {
    process.stderr.write(`api failed to start: ${String(error)}\n`)
    process.exitCode = 1
  })
