import type { Prisma, PrismaClient } from '@flakemetry/db'

export interface AuditInput {
  orgId: string
  projectId?: string | null
  actorId?: string | null
  action: string
  target?: string | null
  details?: Record<string, unknown> | null
}

export interface AuditEntry {
  id: string
  projectId: string | null
  actorId: string | null
  actorName: string | null
  action: string
  target: string | null
  details: unknown
  createdAt: Date
}

export const recordAudit = async (prisma: PrismaClient, input: AuditInput): Promise<void> => {
  await prisma.auditEvent.create({
    data: {
      orgId: input.orgId,
      projectId: input.projectId ?? null,
      actorId: input.actorId ?? null,
      action: input.action,
      target: input.target ?? null,
      details: (input.details ?? undefined) as Prisma.InputJsonValue | undefined,
    },
  })
}

export const listAuditEvents = async (
  prisma: PrismaClient,
  orgId: string,
  options: { limit?: number; before?: Date } = {},
): Promise<AuditEntry[]> => {
  const events = await prisma.auditEvent.findMany({
    where: { orgId, ...(options.before ? { createdAt: { lt: options.before } } : {}) },
    orderBy: { createdAt: 'desc' },
    take: Math.min(Math.max(options.limit ?? 100, 1), 500),
  })
  const actorIds = [
    ...new Set(events.map((event) => event.actorId).filter((id): id is string => !!id)),
  ]
  const actors = actorIds.length
    ? await prisma.user.findMany({
        where: { id: { in: actorIds }, memberships: { some: { orgId } } },
        select: { id: true, name: true, email: true },
      })
    : []
  const names = new Map(actors.map((actor) => [actor.id, actor.name ?? actor.email ?? null]))
  return events.map((event) => ({
    id: event.id,
    projectId: event.projectId,
    actorId: event.actorId,
    actorName: event.actorId ? (names.get(event.actorId) ?? null) : null,
    action: event.action,
    target: event.target,
    details: event.details,
    createdAt: event.createdAt,
  }))
}
