import { ingestRunBatchSchema } from '@flakemetry/contracts'
import type { IngestionQueue, PrismaClient } from '@flakemetry/db'

import type { EventBus } from './events'
import { loadScoringPolicy, type ScoringPolicy } from './policy'
import { processJob } from './processor'
import { workerMetrics } from './telemetry'

export interface WorkerOptions {
  pollIntervalMs?: number
  batchSize?: number
  now?: () => Date
  events?: EventBus
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
    const policyCache = new Map<string, ScoringPolicy>()
    for (const job of jobs) {
      const pickedUpAt = Date.now()
      workerMetrics.processingLag.record(Math.max(0, pickedUpAt - job.createdAt.getTime()))
      try {
        const batch = ingestRunBatchSchema.parse(job.payload)
        let policy = policyCache.get(job.projectId)
        if (!policy) {
          policy = await loadScoringPolicy(prisma, job.projectId)
          policyCache.set(job.projectId, policy)
        }
        await processJob(prisma, batch, {
          orgId: job.orgId,
          projectId: job.projectId,
          now: now(),
          threshold: policy.threshold,
          minSamples: policy.minSamples,
          events: options.events,
        })
        await queue.complete(job.id)
        workerMetrics.jobsProcessed.add(1)
      } catch (error) {
        const outcome = await queue.fail(
          job.id,
          error instanceof Error ? error.message : String(error),
        )
        workerMetrics.jobsFailed.add(1, { outcome })
        if (outcome === 'dead') workerMetrics.jobsDeadLettered.add(1)
        process.stderr.write(`worker: job ${job.id} failed (${outcome}): ${String(error)}\n`)
      } finally {
        workerMetrics.processingDuration.record(Date.now() - pickedUpAt)
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
