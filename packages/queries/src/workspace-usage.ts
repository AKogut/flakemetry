import type { PrismaClient } from '@flakemetry/db'

import { getEffectiveProjectPolicy } from './policy'
import { getProjectUsage, type ProjectUsage } from './usage'

export interface ArtifactSource {
  prefix: string
  store: { list(prefix: string): Promise<{ size: number }[]> }
}

export interface ProjectCaps {
  aiDailyTokenBudget: number
  storageMaxExecutions: number
  storageMaxArtifactMb: number
}

export interface WorkspaceProjectUsage {
  orgId: string
  orgName: string
  projectId: string
  projectName: string
  usage: ProjectUsage
  caps: ProjectCaps
  overExecutionCap: boolean
  overArtifactCap: boolean
}

const MEGABYTE = 1024 * 1024

export const getWorkspaceUsage = async (
  prisma: PrismaClient,
  orgIds: readonly string[],
  options: {
    now?: Date
    env?: Record<string, string | undefined>
    artifactsFor?: (orgId: string, projectId: string) => ArtifactSource | null
  } = {},
): Promise<WorkspaceProjectUsage[]> => {
  if (orgIds.length === 0) return []
  const projects = await prisma.project.findMany({
    where: { orgId: { in: [...orgIds] } },
    orderBy: [{ org: { name: 'asc' } }, { name: 'asc' }],
    select: { id: true, name: true, orgId: true, org: { select: { name: true } } },
  })

  const rows: WorkspaceProjectUsage[] = []
  for (const project of projects) {
    const { effective } = await getEffectiveProjectPolicy(prisma, project.id, options.env)
    const caps: ProjectCaps = {
      aiDailyTokenBudget: effective.aiDailyTokenBudget.value,
      storageMaxExecutions: effective.storageMaxExecutions.value,
      storageMaxArtifactMb: effective.storageMaxArtifactMb.value,
    }
    const usage = await getProjectUsage(prisma, project.id, caps.aiDailyTokenBudget, {
      now: options.now,
      artifacts: options.artifactsFor?.(project.orgId, project.id) ?? null,
    })
    rows.push({
      orgId: project.orgId,
      orgName: project.org.name,
      projectId: project.id,
      projectName: project.name,
      usage,
      caps,
      overExecutionCap:
        caps.storageMaxExecutions > 0 && usage.rows.executions > caps.storageMaxExecutions,
      overArtifactCap:
        caps.storageMaxArtifactMb > 0 &&
        (usage.artifacts?.bytes ?? 0) > caps.storageMaxArtifactMb * MEGABYTE,
    })
  }
  return rows
}
