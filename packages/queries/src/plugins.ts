import type { PrismaClient } from '@flakemetry/db'

export interface PluginSignalView {
  plugin: string
  code: string
  severity: string
  message: string
  data: unknown
  runId: string
  updatedAt: Date
}

export const listPluginSignals = async (
  prisma: PrismaClient,
  projectId: string,
  testIdentityId: string,
): Promise<PluginSignalView[]> =>
  prisma.pluginSignal.findMany({
    where: { projectId, testIdentityId },
    orderBy: [{ severity: 'desc' }, { updatedAt: 'desc' }],
    select: {
      plugin: true,
      code: true,
      severity: true,
      message: true,
      data: true,
      runId: true,
      updatedAt: true,
    },
  })
