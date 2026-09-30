import type { PrismaClient } from '@flakemetry/db'

import { canManage } from './access'

export const TEAM_NAME_MAX = 80

export type TeamRefusal =
  | 'not-a-manager'
  | 'empty-name'
  | 'name-too-long'
  | 'invalid-handle'
  | 'name-taken'
  | 'handle-taken'

const HANDLE = /^@[a-z0-9][a-z0-9._-]*(?:\/[a-z0-9][a-z0-9._-]*)+$/

export const normalizeTeamHandle = (raw: string): string | null | 'invalid' => {
  const trimmed = raw.trim().toLowerCase()
  if (trimmed === '') return null
  const handle = trimmed.startsWith('@') ? trimmed : `@${trimmed}`
  return HANDLE.test(handle) ? handle : 'invalid'
}

export const teamSlug = (name: string): string =>
  name
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48)

export const checkTeam = (input: {
  actorRole: string
  name: string
  handle: string
}): TeamRefusal | null => {
  if (!canManage(input.actorRole)) return 'not-a-manager'
  const name = input.name.trim()
  if (name === '' || teamSlug(name) === '') return 'empty-name'
  if (name.length > TEAM_NAME_MAX) return 'name-too-long'
  if (normalizeTeamHandle(input.handle) === 'invalid') return 'invalid-handle'
  return null
}

export interface TeamMemberRow {
  userId: string
  name: string | null
  email: string | null
}

export interface TeamRow {
  id: string
  name: string
  slug: string
  handle: string | null
  members: TeamMemberRow[]
}

export const listTeams = async (prisma: PrismaClient, orgId: string): Promise<TeamRow[]> => {
  const teams = await prisma.team.findMany({
    where: { orgId },
    orderBy: { name: 'asc' },
    select: {
      id: true,
      name: true,
      slug: true,
      handle: true,
      members: {
        orderBy: { createdAt: 'asc' },
        select: {
          userId: true,
          membership: { select: { user: { select: { name: true, email: true } } } },
        },
      },
    },
  })

  return teams.map((team) => ({
    id: team.id,
    name: team.name,
    slug: team.slug,
    handle: team.handle,
    members: team.members.map((member) => ({
      userId: member.userId,
      name: member.membership.user.name,
      email: member.membership.user.email,
    })),
  }))
}

export const findTeam = (
  prisma: PrismaClient,
  orgId: string,
  teamId: string,
): Promise<{ id: string; name: string } | null> =>
  prisma.team.findFirst({ where: { id: teamId, orgId }, select: { id: true, name: true } })

export type SaveTeamOutcome =
  { status: 'saved'; id: string } | { status: 'rejected'; reason: 'name-taken' | 'handle-taken' }

const conflict = async (
  prisma: PrismaClient,
  orgId: string,
  slug: string,
  handle: string | null,
  exceptId?: string,
): Promise<'name-taken' | 'handle-taken' | null> => {
  const others = await prisma.team.findMany({
    where: {
      orgId,
      ...(exceptId ? { id: { not: exceptId } } : {}),
      OR: [{ slug }, ...(handle ? [{ handle }] : [])],
    },
    select: { slug: true, handle: true },
  })
  if (others.some((other) => other.slug === slug)) return 'name-taken'
  if (handle && others.some((other) => other.handle === handle)) return 'handle-taken'
  return null
}

const isUniqueViolation = (error: unknown): boolean => (error as { code?: string }).code === 'P2002'

export const createTeam = async (
  prisma: PrismaClient,
  input: { orgId: string; name: string; handle: string },
): Promise<SaveTeamOutcome> => {
  const name = input.name.trim()
  const slug = teamSlug(name)
  const normalized = normalizeTeamHandle(input.handle)
  const handle = normalized === 'invalid' ? null : normalized

  const taken = await conflict(prisma, input.orgId, slug, handle)
  if (taken) return { status: 'rejected', reason: taken }

  try {
    const team = await prisma.team.create({
      data: { orgId: input.orgId, name, slug, handle },
      select: { id: true },
    })
    return { status: 'saved', id: team.id }
  } catch (error) {
    if (!isUniqueViolation(error)) throw error
    return {
      status: 'rejected',
      reason: (await conflict(prisma, input.orgId, slug, handle)) ?? 'name-taken',
    }
  }
}

export const updateTeam = async (
  prisma: PrismaClient,
  input: { orgId: string; teamId: string; name: string; handle: string },
): Promise<SaveTeamOutcome | null> => {
  const name = input.name.trim()
  const slug = teamSlug(name)
  const normalized = normalizeTeamHandle(input.handle)
  const handle = normalized === 'invalid' ? null : normalized

  const taken = await conflict(prisma, input.orgId, slug, handle, input.teamId)
  if (taken) return { status: 'rejected', reason: taken }

  try {
    const { count } = await prisma.team.updateMany({
      where: { id: input.teamId, orgId: input.orgId },
      data: { name, slug, handle },
    })
    return count > 0 ? { status: 'saved', id: input.teamId } : null
  } catch (error) {
    if (!isUniqueViolation(error)) throw error
    return {
      status: 'rejected',
      reason: (await conflict(prisma, input.orgId, slug, handle, input.teamId)) ?? 'name-taken',
    }
  }
}

export const deleteTeam = async (
  prisma: PrismaClient,
  orgId: string,
  teamId: string,
): Promise<boolean> => {
  const { count } = await prisma.team.deleteMany({ where: { id: teamId, orgId } })
  return count > 0
}

export type TeamMemberOutcome = 'added' | 'already' | 'unknown-team' | 'not-a-member'

export const addTeamMember = async (
  prisma: PrismaClient,
  input: { orgId: string; teamId: string; userId: string },
): Promise<TeamMemberOutcome> => {
  const [team, membership] = await Promise.all([
    findTeam(prisma, input.orgId, input.teamId),
    prisma.membership.findFirst({
      where: { orgId: input.orgId, userId: input.userId },
      select: { id: true },
    }),
  ])
  if (!team) return 'unknown-team'
  if (!membership) return 'not-a-member'

  try {
    await prisma.teamMember.create({
      data: { teamId: input.teamId, orgId: input.orgId, userId: input.userId },
    })
    return 'added'
  } catch (error) {
    if (!isUniqueViolation(error)) throw error
    return 'already'
  }
}

export const removeTeamMember = async (
  prisma: PrismaClient,
  input: { orgId: string; teamId: string; userId: string },
): Promise<boolean> => {
  const { count } = await prisma.teamMember.deleteMany({
    where: { teamId: input.teamId, orgId: input.orgId, userId: input.userId },
  })
  return count > 0
}

export const teamsByHandle = async (
  prisma: PrismaClient,
  orgId: string,
  owners: readonly string[],
): Promise<Map<string, string>> => {
  const handles = new Map<string, string>()
  for (const owner of owners) {
    const handle = normalizeTeamHandle(owner)
    if (handle !== null && handle !== 'invalid') handles.set(owner, handle)
  }
  if (handles.size === 0) return new Map()

  const teams = await prisma.team.findMany({
    where: { orgId, handle: { in: [...new Set(handles.values())] } },
    select: { handle: true, name: true },
  })
  const nameByHandle = new Map(teams.map((team) => [team.handle, team.name]))

  const named = new Map<string, string>()
  for (const [owner, handle] of handles) {
    const name = nameByHandle.get(handle)
    if (name) named.set(owner, name)
  }
  return named
}
