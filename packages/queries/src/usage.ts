import type { PrismaClient } from '@flakemetry/db'

export interface AiSpend {
  spentToday: number
  budget: number
  /** Null when no budget is set, since a share of nothing is not zero. */
  fraction: number | null
  exhausted: boolean
  reportsToday: number
}

export interface StoredRows {
  executions: number
  runs: number
  identities: number
  rcaReports: number
}

export interface ArtifactUsage {
  objects: number
  bytes: number
}

export interface ProjectUsage {
  ai: AiSpend
  rows: StoredRows
  artifacts: ArtifactUsage | null
  oldestExecution: Date | null
}

const startOfUtcDay = (now: Date): Date => {
  const day = new Date(now)
  day.setUTCHours(0, 0, 0, 0)
  return day
}

/**
 * What this project is costing, from data already collected. The AI budget was enforceable
 * but invisible: the worker stops calling the model when the day's tokens run out and says
 * so only in a metric, so from the dashboard a project with root-cause analysis switched on
 * and a project that quietly stopped analysing look identical.
 */
export const getProjectUsage = async (
  prisma: PrismaClient,
  projectId: string,
  budget: number,
  options: {
    now?: Date
    artifacts?: {
      prefix: string
      store: { list(prefix: string): Promise<{ size: number }[]> }
    } | null
  } = {},
): Promise<ProjectUsage> => {
  const now = options.now ?? new Date()
  const since = startOfUtcDay(now)

  const [spend, reportsToday, executions, runs, identities, rcaReports, oldest] = await Promise.all(
    [
      prisma.rcaReport.aggregate({
        where: { projectId, createdAt: { gte: since } },
        _sum: { tokenCost: true },
      }),
      prisma.rcaReport.count({ where: { projectId, createdAt: { gte: since } } }),
      prisma.testExecution.count({ where: { projectId } }),
      prisma.run.count({ where: { projectId } }),
      prisma.testIdentity.count({ where: { projectId } }),
      prisma.rcaReport.count({ where: { projectId } }),
      prisma.testExecution.findFirst({
        where: { projectId },
        orderBy: { startedAt: 'asc' },
        select: { startedAt: true },
      }),
    ],
  )

  const spentToday = spend._sum.tokenCost ?? 0

  // Listing a bucket is the only way to know what it holds, and it is the slowest thing
  // here, so a store that is unreachable degrades the page rather than breaking it.
  let artifacts: ArtifactUsage | null = null
  if (options.artifacts) {
    try {
      const objects = await options.artifacts.store.list(options.artifacts.prefix)
      artifacts = {
        objects: objects.length,
        bytes: objects.reduce((total, object) => total + object.size, 0),
      }
    } catch {
      artifacts = null
    }
  }

  return {
    ai: {
      spentToday,
      budget,
      fraction: budget > 0 ? spentToday / budget : null,
      exhausted: budget > 0 && spentToday >= budget,
      reportsToday,
    },
    rows: { executions, runs, identities, rcaReports },
    artifacts,
    oldestExecution: oldest?.startedAt ?? null,
  }
}

export const formatBytes = (bytes: number): string => {
  if (bytes < 1024) return `${bytes} B`
  const units = ['KB', 'MB', 'GB', 'TB']
  let value = bytes / 1024
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024
    unit += 1
  }
  return `${value < 10 ? value.toFixed(1) : Math.round(value)} ${units[unit]}`
}
