import { ingestRunBatchSchema } from '@flakemetry/contracts'
import type { IngestionQueue, PrismaClient } from '@flakemetry/db'

import { processJob } from './processor'

export interface WorkerOptions {
  pollIntervalMs?: number
  batchSize?: number
  now?: () => Date
}

export interface Worker {
  tick: () => Promise<number>
  start: () => Promise<void>
  stop: () => void
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

export const createWorker = (
  prisma: PrismaClient,
  queue: IngestionQueue,
  options: WorkerOptions = {},
): Worker => {
  const pollIntervalMs = options.pollIntervalMs ?? 1_000
  const batchSize = options.batchSize ?? 5
  const now = options.now ?? (() => new Date())
  let running = false

  const tick = async (): Promise<number> => {
    const jobs = await queue.dequeue(batchSize)
    for (const job of jobs) {
      try {
        const batch = ingestRunBatchSchema.parse(job.payload)
        await processJob(prisma, batch, { orgId: job.orgId, projectId: job.projectId, now: now() })
        await queue.complete(job.id)
      } catch (error) {
        const outcome = await queue.fail(
          job.id,
          error instanceof Error ? error.message : String(error),
        )
        process.stderr.write(`worker: job ${job.id} failed (${outcome}): ${String(error)}\n`)
      }
    }
    return jobs.length
  }

  return {
    tick,
    async start() {
      running = true
      while (running) {
        const processed = await tick()
        if (processed === 0) await sleep(pollIntervalMs)
      }
    },
    stop() {
      running = false
    },
  }
}
