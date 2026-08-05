import type { TokenScope } from '@flakemetry/contracts'
import { hashToken, type PrismaClient } from '@flakemetry/db'
import type { FastifyRequest } from 'fastify'

export interface AuthenticatedProject {
  orgId: string
  projectId: string
  tokenId: string
  scopes: string[]
}

/**
 * A token that predates scopes, or one written by an older client, is treated as ingest-only.
 * Defaulting the other way would silently widen every CI credential already in circulation.
 */
export const hasScope = (project: AuthenticatedProject, scope: TokenScope): boolean =>
  (project.scopes.length > 0 ? project.scopes : ['ingest']).includes(scope)

const extractBearer = (request: FastifyRequest): string | null => {
  const header = request.headers.authorization
  if (!header) return null
  const [scheme, value] = header.split(' ')
  if (scheme?.toLowerCase() !== 'bearer' || !value) return null
  return value.trim()
}

export const authenticateProject = async (
  prisma: PrismaClient,
  request: FastifyRequest,
): Promise<AuthenticatedProject | null> => {
  const token = extractBearer(request)
  if (!token) return null

  const record = await prisma.ingestToken.findFirst({
    where: { tokenHash: hashToken(token), revokedAt: null },
    select: { id: true, orgId: true, projectId: true, scopes: true },
  })
  if (!record) return null

  void prisma.ingestToken
    .update({ where: { id: record.id }, data: { lastUsedAt: new Date() } })
    .catch(() => undefined)

  return {
    orgId: record.orgId,
    projectId: record.projectId,
    tokenId: record.id,
    scopes: record.scopes,
  }
}
