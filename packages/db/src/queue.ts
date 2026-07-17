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
}

export interface IngestionQueueOptions {
  visibilityTimeoutMs?: number
  maxAttempts?: number
  baseBackoffMs?: number
}

const DEFAULTS = {
  visibilityTimeoutMs: 60_000,
  maxAttempts: 5,
  baseBackoffMs: 2_000,
}

export class IngestionQueue {
  private readonly options: Required<IngestionQueueOptions>

  constructor(
    private readonly prisma: PrismaClient,
    options: IngestionQueueOptions = {},
  ) {
    this.options = { ...DEFAULTS, ...options }
  }

  async enqueue(input: EnqueueInput): Promise<EnqueueResult> {
    const existing = await this.prisma.ingestionJob.findUnique({
      where: {
        projectId_idempotencyKey: {
          projectId: input.projectId,
          idempotencyKey: input.idempotencyKey,
        },
      },
      select: { id: true },
    })
    if (existing) return { jobId: existing.id, deduplicated: true }

    const job = await this.prisma.ingestionJob.create({
      data: {
        orgId: input.orgId,
        projectId: input.projectId,
        idempotencyKey: input.idempotencyKey,
        payload: input.payload,
      },
      select: { id: true },
    })
    return { jobId: job.id, deduplicated: false }
  }

  async dequeue(limit = 1): Promise<QueuedJob[]> {
    const timeout = `${Math.round(this.options.visibilityTimeoutMs / 1000)} seconds`
    return this.prisma.$queryRaw<QueuedJob[]>`
      UPDATE ingestion_job
      SET status = 'processing',
          attempts = attempts + 1,
          visible_at = now() + ${timeout}::interval,
          updated_at = now()
      WHERE id IN (
        SELECT id FROM ingestion_job
        WHERE status IN ('pending', 'processing')
          AND visible_at <= now()
        ORDER BY visible_at ASC
        LIMIT ${limit}
        FOR UPDATE SKIP LOCKED
      )
      RETURNING id, org_id AS "orgId", project_id AS "projectId",
                idempotency_key AS "idempotencyKey", payload, attempts
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
    await this.prisma.ingestionJob.update({
      where: { id: jobId },
      data: {
        status: 'pending',
        lastError: error,
        visibleAt: new Date(Date.now() + backoffMs),
      },
    })
    return 'retry'
  }

  async depth(): Promise<number> {
    return this.prisma.ingestionJob.count({ where: { status: 'pending' } })
  }
}
