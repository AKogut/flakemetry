import { createHash } from 'node:crypto'

import type { Prisma, PrismaClient } from '@prisma/client'

export interface EnqueueInput {
  orgId: string
  projectId: string
  idempotencyKey: string
  payload: Prisma.InputJsonValue
}

export interface EnqueueResult {
  jobId: string
  deduplicated: boolean
}

export interface QueuedJob {
  id: string
  orgId: string
  projectId: string
  idempotencyKey: string
  payload: unknown
  attempts: number
  createdAt: Date
}

export interface IngestionQueueOptions {
  visibilityTimeoutMs?: number
  maxAttempts?: number
  baseBackoffMs?: number
}

const DEFAULTS = {
  visibilityTimeoutMs: 300_000,
  maxAttempts: 5,
  baseBackoffMs: 2_000,
}

const MAX_IDEMPOTENCY_KEY_LENGTH = 128
const SIBLING_SUFFIX_LENGTH = 12

export const batchContentDigest = (payload: unknown): string | null => {
  const executions = (payload as { executions?: unknown } | null)?.executions
  if (!Array.isArray(executions)) return null
  const lines = (executions as Record<string, unknown>[])
    .map((execution) =>
      JSON.stringify([
        execution.filePath,
        execution.suite,
        execution.title,
        execution.params ?? null,
        execution.status,
        execution.attempt,
        execution.durationMs,
      ]),
    )
    .sort()
  return createHash('sha256').update(lines.join('\n')).digest('hex')
}

const siblingKey = (idempotencyKey: string, digest: string): string =>
  `${idempotencyKey.slice(0, MAX_IDEMPOTENCY_KEY_LENGTH - SIBLING_SUFFIX_LENGTH - 1)}~${digest.slice(0, SIBLING_SUFFIX_LENGTH)}`

export class IngestionQueue {
  private readonly options: Required<IngestionQueueOptions>

  constructor(
    private readonly prisma: PrismaClient,
    options: IngestionQueueOptions = {},
  ) {
    this.options = { ...DEFAULTS, ...options }
  }

  private async createJob(
    input: EnqueueInput,
    idempotencyKey: string,
    payload: Prisma.InputJsonValue,
    contentDigest: string | null,
  ): Promise<string | null> {
    try {
      const job = await this.prisma.ingestionJob.create({
        data: {
          orgId: input.orgId,
          projectId: input.projectId,
          idempotencyKey,
          payload,
          contentDigest,
        },
        select: { id: true },
      })
      return job.id
    } catch (error) {
      if ((error as { code?: string }).code !== 'P2002') throw error
      return null
    }
  }

  private findJob(projectId: string, idempotencyKey: string) {
    return this.prisma.ingestionJob.findUniqueOrThrow({
      where: { projectId_idempotencyKey: { projectId, idempotencyKey } },
      select: { id: true, contentDigest: true },
    })
  }

  async enqueue(input: EnqueueInput): Promise<EnqueueResult> {
    const contentDigest = batchContentDigest(input.payload)
    const created = await this.createJob(input, input.idempotencyKey, input.payload, contentDigest)
    if (created) return { jobId: created, deduplicated: false }

    const existing = await this.findJob(input.projectId, input.idempotencyKey)
    if (!contentDigest || !existing.contentDigest || existing.contentDigest === contentDigest) {
      return { jobId: existing.id, deduplicated: true }
    }

    const key = siblingKey(input.idempotencyKey, contentDigest)
    const sibling = await this.createJob(
      input,
      key,
      { ...(input.payload as Prisma.InputJsonObject), idempotencyKey: key },
      contentDigest,
    )
    if (sibling) return { jobId: sibling, deduplicated: false }

    const redelivered = await this.findJob(input.projectId, key)
    return { jobId: redelivered.id, deduplicated: true }
  }

  async dequeue(limit = 1): Promise<QueuedJob[]> {
    const timeout = `${this.options.visibilityTimeoutMs} milliseconds`
    return this.prisma.$queryRaw<QueuedJob[]>`
      UPDATE ingestion_job
      SET status = 'processing',
          attempts = attempts + 1,
          visible_at = now() + ${timeout}::interval,
          updated_at = now()
      WHERE id IN (
        SELECT id FROM ingestion_job
        WHERE status IN ('pending', 'processing')
          AND visible_at <= now() + '1 millisecond'::interval
        ORDER BY visible_at ASC
        LIMIT ${limit}
        FOR UPDATE SKIP LOCKED
      )
      RETURNING id, org_id AS "orgId", project_id AS "projectId",
                idempotency_key AS "idempotencyKey", payload, attempts,
                created_at AS "createdAt"
    `
  }

  async complete(jobId: string): Promise<void> {
    await this.prisma.ingestionJob.update({
      where: { id: jobId },
      data: { status: 'done' },
    })
  }

  async fail(jobId: string, error: string): Promise<'retry' | 'dead'> {
    const job = await this.prisma.ingestionJob.findUniqueOrThrow({
      where: { id: jobId },
      select: { attempts: true },
    })
    if (job.attempts >= this.options.maxAttempts) {
      await this.prisma.ingestionJob.update({
        where: { id: jobId },
        data: { status: 'dead', lastError: error },
      })
      return 'dead'
    }
    const backoffMs = this.options.baseBackoffMs * 2 ** (job.attempts - 1)
    const backoff = `${backoffMs} milliseconds`
    await this.prisma.$executeRaw`
      UPDATE ingestion_job
      SET status = 'pending',
          last_error = ${error},
          visible_at = now() + ${backoff}::interval,
          updated_at = now()
      WHERE id = ${jobId}::uuid
    `
    return 'retry'
  }

  async depth(): Promise<number> {
    return this.prisma.ingestionJob.count({
      where: { status: { in: ['pending', 'processing'] } },
    })
  }
}
