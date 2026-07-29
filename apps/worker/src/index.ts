import { getPrismaClient, IngestionQueue } from '@flakemetry/db'
import { pruneArtifacts, resolveObjectStore } from '@flakemetry/storage'

import { createEventBus } from './events'
import { pruneRawExecutions } from './rollups'
import { createWorker } from './runner'
import { initSelfTelemetry, observeQueueDepth } from './telemetry'

const RETENTION_INTERVAL_MS = 6 * 60 * 60 * 1000

const startExecutionRetention = (prisma: ReturnType<typeof getPrismaClient>): void => {
  const days = Number(process.env.FLAKEMETRY_EXECUTION_RETENTION_DAYS ?? 0)
  if (!Number.isFinite(days) || days <= 0) return

  const sweep = (): void => {
    void pruneRawExecutions(prisma, { olderThanDays: days })
      .then((count) => {
        if (count > 0) process.stdout.write(`worker: pruned ${count} raw execution(s)\n`)
      })
      .catch((error: unknown) => {
        process.stderr.write(`worker: execution prune failed ${String(error)}\n`)
      })
  }

  sweep()
  setInterval(sweep, RETENTION_INTERVAL_MS).unref()
}

const startArtifactRetention = (): void => {
  const store = resolveObjectStore(process.env)
  const days = Number(process.env.FLAKEMETRY_ARTIFACT_RETENTION_DAYS ?? 0)
  if (!store || !Number.isFinite(days) || days <= 0) return

  const sweep = (): void => {
    void pruneArtifacts(store, { olderThanDays: days })
      .then((result) => {
        if (result.deleted.length > 0) {
          process.stdout.write(`worker: pruned ${result.deleted.length} expired artifact(s)\n`)
        }
      })
      .catch((error: unknown) => {
        process.stderr.write(`worker: artifact prune failed ${String(error)}\n`)
      })
  }

  sweep()
  setInterval(sweep, RETENTION_INTERVAL_MS).unref()
}

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

startArtifactRetention()
startExecutionRetention(prisma)

process.stdout.write('worker: started\n')
worker.start().catch((error: unknown) => {
  process.stderr.write(`worker: fatal ${String(error)}\n`)
  process.exitCode = 1
})
