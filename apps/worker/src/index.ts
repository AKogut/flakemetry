import { getPrismaClient, IngestionQueue } from '@flakemetry/db'

import { createEventBus } from './events'
import { createWorker } from './runner'
import { initSelfTelemetry, observeQueueDepth } from './telemetry'

const prisma = getPrismaClient()
const queue = new IngestionQueue(prisma)

const selfOtelEndpoint = process.env.FLAKEMETRY_SELF_OTEL_ENDPOINT
const shutdownTelemetry = selfOtelEndpoint
  ? initSelfTelemetry({ endpoint: selfOtelEndpoint })
  : undefined

observeQueueDepth(() => queue.depth())

const events = createEventBus((error) => {
  process.stderr.write(`worker: event handler failed ${String(error)}\n`)
})

const worker = createWorker(prisma, queue, {
  pollIntervalMs: Number(process.env.POLL_INTERVAL_MS ?? 1_000),
  events,
})

const shutdown = () => {
  process.stdout.write('worker: shutting down\n')
  worker.stop()
  void shutdownTelemetry?.()
}
process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)

process.stdout.write('worker: started\n')
worker.start().catch((error: unknown) => {
  process.stderr.write(`worker: fatal ${String(error)}\n`)
  process.exitCode = 1
})
