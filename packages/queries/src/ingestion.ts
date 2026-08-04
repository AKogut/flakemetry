import type { PrismaClient } from '@flakemetry/db'

export interface FailedIngestion {
  id: string
  idempotencyKey: string
  attempts: number
  lastError: string | null
  createdAt: Date
  updatedAt: Date
}

export interface IngestionHealth {
  failed: number
  recent: FailedIngestion[]
}

const RECENT_LIMIT = 5

/**
 * A batch that exhausts its retries is dropped, and until this was read anywhere the only
 * trace was a line on the worker's stderr — the API had already answered 202, so whoever
 * pushed the run saw success and then an empty dashboard. Surfacing it matters most while
 * a project is being wired up, which is exactly when ingestion is most likely to fail.
 */
export const getIngestionHealth = async (
  prisma: PrismaClient,
  projectId: string,
  limit = RECENT_LIMIT,
): Promise<IngestionHealth> => {
  const [failed, recent] = await Promise.all([
    prisma.ingestionJob.count({ where: { projectId, status: 'dead' } }),
    prisma.ingestionJob.findMany({
      where: { projectId, status: 'dead' },
      orderBy: { updatedAt: 'desc' },
      take: limit,
      select: {
        id: true,
        idempotencyKey: true,
        attempts: true,
        lastError: true,
        createdAt: true,
        updatedAt: true,
      },
    }),
  ])

  return { failed, recent }
}
