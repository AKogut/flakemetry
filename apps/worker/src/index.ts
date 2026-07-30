import { getPrismaClient, IngestionQueue } from '@flakemetry/db'
import { pruneArtifacts, resolveObjectStore } from '@flakemetry/storage'

import { createEventBus } from './events'
import { startNotifications } from './notify'
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
  const configured = Number(process.env.FLAKEMETRY_ARTIFACT_RETENTION_DAYS ?? 0)
  if (!store || !Number.isFinite(configured) || configured <= 0) return

  const executionDays = Number(process.env.FLAKEMETRY_EXECUTION_RETENTION_DAYS ?? 0)
  const days =
    Number.isFinite(executionDays) && executionDays > configured ? executionDays : configured
  if (days > configured) {
    process.stdout.write(
      `worker: artifact retention raised to ${days}d to outlive execution retention\n`,
    )
  }

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

startArtifactRetention()
startExecutionRetention(prisma)

process.stdout.write('worker: started\n')
worker.start().catch((error: unknown) => {
  process.stderr.write(`worker: fatal ${String(error)}\n`)
  process.exitCode = 1
})
