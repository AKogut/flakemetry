import { getPrismaClient, IngestionQueue } from '@flakemetry/db'

import { createWorker } from './runner'

const prisma = getPrismaClient()
const queue = new IngestionQueue(prisma)
const worker = createWorker(prisma, queue, {
  pollIntervalMs: Number(process.env.POLL_INTERVAL_MS ?? 1_000),
})

const shutdown = () => {
  process.stdout.write('worker: shutting down\n')
  worker.stop()
}
process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)

process.stdout.write('worker: started\n')
worker.start().catch((error: unknown) => {
  process.stderr.write(`worker: fatal ${String(error)}\n`)
  process.exitCode = 1
})
