import { getPrismaClient, IngestionQueue } from '@flakemetry/db'
import { resolveObjectStore } from '@flakemetry/storage'

import { createEventBus } from './events'
import { startNotifications } from './notify'
import { startRetention } from './retention'
import { createWorker } from './runner'
import { initSelfTelemetry, observeQueueDepth } from './telemetry'

const prisma = getPrismaClient()
const visibilityTimeoutMs = Number(process.env.FLAKEMETRY_QUEUE_VISIBILITY_MS)
const queue = new IngestionQueue(
  prisma,
  Number.isFinite(visibilityTimeoutMs) && visibilityTimeoutMs > 0 ? { visibilityTimeoutMs } : {},
)

const SHUTDOWN_DEADLINE_MS = 15_000

const selfOtelEndpoint = process.env.FLAKEMETRY_SELF_OTEL_ENDPOINT
const shutdownTelemetry = selfOtelEndpoint
  ? initSelfTelemetry({ endpoint: selfOtelEndpoint })
  : undefined

observeQueueDepth(() => queue.depth())

const events = createEventBus((error) => {
  process.stderr.write(`worker: event handler failed ${String(error)}\n`)
})

if (startNotifications(events)) {
  process.stdout.write('worker: notifications enabled\n')
}

const worker = createWorker(prisma, queue, {
  pollIntervalMs: Number(process.env.POLL_INTERVAL_MS ?? 1_000),
  events,
})

let shuttingDown = false
const shutdown = async (): Promise<void> => {
  if (shuttingDown) return
  shuttingDown = true
  process.stdout.write('worker: shutting down\n')
  worker.stop()
  const deadline = new Promise<void>((resolve) => setTimeout(resolve, SHUTDOWN_DEADLINE_MS).unref())
  await Promise.race([worker.drain(), deadline])
  await shutdownTelemetry?.()
  await prisma.$disconnect().catch(() => {})
  process.exit(0)
}
process.on('SIGINT', () => void shutdown())
process.on('SIGTERM', () => void shutdown())

startRetention(prisma, resolveObjectStore(process.env))

process.stdout.write('worker: started\n')
worker.start().catch((error: unknown) => {
  process.stderr.write(`worker: fatal ${String(error)}\n`)
  process.exitCode = 1
})
