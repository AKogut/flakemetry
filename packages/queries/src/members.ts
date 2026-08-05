import type { PrismaClient } from '@flakemetry/db'

export type MemberRole = 'owner' | 'admin' | 'member'

export const MEMBER_ROLES: readonly MemberRole[] = ['owner', 'admin', 'member']

export const isMemberRole = (value: string): value is MemberRole =>
  (MEMBER_ROLES as readonly string[]).includes(value)

export type MemberRefusal = 'not-a-manager' | 'owner-only' | 'last-owner' | 'unknown-role'

const manages = (role: string): boolean => role === 'owner' || role === 'admin'

/**
 * An admin may bring in teammates; only an owner may create another admin or owner.
 * Otherwise an admin could quietly grant away control of the workspace, which is an
 * escalation dressed up as an invitation.
 */
export const checkInvite = (input: {
  actorRole: string
  invitedRole: string
}): MemberRefusal | null => {
  if (!manages(input.actorRole)) return 'not-a-manager'
  if (!isMemberRole(input.invitedRole)) return 'unknown-role'
  if (input.invitedRole !== 'member' && input.actorRole !== 'owner') return 'owner-only'
  return null
}

/**
 * Changing what someone is allowed to do is an owner's call. The last owner cannot be
 * demoted: a workspace with no owner has nobody who can invite, delete or hand it over,
 * and no way back short of the database.
 */
export const checkRoleChange = (input: {
  actorRole: string
  targetRole: string
  newRole: string
  ownerCount: number
}): MemberRefusal | null => {
  if (!manages(input.actorRole)) return 'not-a-manager'
  if (input.actorRole !== 'owner') return 'owner-only'
  if (!isMemberRole(input.newRole)) return 'unknown-role'
  if (input.targetRole === 'owner' && input.newRole !== 'owner' && input.ownerCount <= 1) {
    return 'last-owner'
  }
  return null
}

export const checkRemoval = (input: {
  actorRole: string
  targetRole: string
  ownerCount: number
}): MemberRefusal | null => {
  if (!manages(input.actorRole)) return 'not-a-manager'
  if (input.targetRole !== 'member' && input.actorRole !== 'owner') return 'owner-only'
  if (input.targetRole === 'owner' && input.ownerCount <= 1) return 'last-owner'
  return null
}

export const INVITATION_TTL_MS = 7 * 24 * 60 * 60 * 1000

export type InvitationState = 'pending' | 'accepted' | 'revoked' | 'expired'

export const invitationState = (
  invitation: { acceptedAt: Date | null; revokedAt: Date | null; expiresAt: Date },
  now: Date,
): InvitationState => {
  if (invitation.acceptedAt) return 'accepted'
  if (invitation.revokedAt) return 'revoked'
  if (invitation.expiresAt.getTime() <= now.getTime()) return 'expired'
  return 'pending'
}

export interface MemberRow {
  userId: string
  name: string | null
  email: string | null
  role: MemberRole
  joinedAt: Date
}

export const listMembers = async (prisma: PrismaClient, orgId: string): Promise<MemberRow[]> => {
  const rows = await prisma.membership.findMany({
    where: { orgId },
    orderBy: { createdAt: 'asc' },
    select: {
      userId: true,
      role: true,
      createdAt: true,
      user: { select: { name: true, email: true } },
    },
  })

  return rows.map((row) => ({
    userId: row.userId,
    name: row.user.name,
    email: row.user.email,
    role: row.role,
    joinedAt: row.createdAt,
  }))
}

export const countOwners = async (prisma: PrismaClient, orgId: string): Promise<number> =>
  prisma.membership.count({ where: { orgId, role: 'owner' } })

export interface InvitationRow {
  id: string
  email: string
  role: MemberRole
  state: InvitationState
  expiresAt: Date
  createdAt: Date
}

export const listInvitations = async (
  prisma: PrismaClient,
  orgId: string,
  now: Date = new Date(),
): Promise<InvitationRow[]> => {
  const rows = await prisma.invitation.findMany({
    where: { orgId },
    orderBy: { createdAt: 'desc' },
    take: 50,
    select: {
      id: true,
      email: true,
      role: true,
      acceptedAt: true,
      revokedAt: true,
      expiresAt: true,
      createdAt: true,
    },
  })

  return rows.map((row) => ({
    id: row.id,
    email: row.email,
    role: row.role,
    state: invitationState(row, now),
    expiresAt: row.expiresAt,
    createdAt: row.createdAt,
  }))
}

export interface CreateInvitationParams {
  orgId: string
  email: string
  role: MemberRole
  invitedBy: string
  tokenHash: string
  now?: Date
}

export const createInvitation = async (
  prisma: PrismaClient,
  params: CreateInvitationParams,
): Promise<{ id: string; expiresAt: Date }> => {
  const now = params.now ?? new Date()
  const expiresAt = new Date(now.getTime() + INVITATION_TTL_MS)

  const created = await prisma.invitation.create({
    data: {
      orgId: params.orgId,
      email: params.email.trim().toLowerCase(),
      role: params.role,
      tokenHash: params.tokenHash,
      invitedBy: params.invitedBy,
      expiresAt,
    },
    select: { id: true },
  })

  return { id: created.id, expiresAt }
}

export const revokeInvitation = async (
  prisma: PrismaClient,
  orgId: string,
  invitationId: string,
  now: Date = new Date(),
): Promise<boolean> => {
  const { count } = await prisma.invitation.updateMany({
    where: { id: invitationId, orgId, acceptedAt: null, revokedAt: null },
    data: { revokedAt: now },
  })
  return count > 0
}

export interface PendingInvitation {
  id: string
  orgId: string
  orgName: string
  email: string
  role: MemberRole
  expiresAt: Date
}

export const findInvitationByHash = async (
  prisma: PrismaClient,
  tokenHash: string,
): Promise<(PendingInvitation & { state: InvitationState }) | null> => {
  const row = await prisma.invitation.findUnique({
    where: { tokenHash },
    select: {
      id: true,
      orgId: true,
      email: true,
      role: true,
      expiresAt: true,
      acceptedAt: true,
      revokedAt: true,
      org: { select: { name: true } },
    },
  })
  if (!row) return null

  return {
    id: row.id,
    orgId: row.orgId,
    orgName: row.org.name,
    email: row.email,
    role: row.role,
    expiresAt: row.expiresAt,
    state: invitationState(row, new Date()),
  }
}

export type AcceptOutcome =
  | { status: 'joined'; orgId: string; role: MemberRole }
  | { status: 'already-a-member'; orgId: string }
  | { status: 'rejected'; reason: InvitationState | 'unknown' }

/**
 * The link is the credential — accepting does not require the signed-in address to match
 * the one invited. Requiring it would lock out everyone whose GitHub email is private or
 * absent (`User.email` is nullable here for exactly that reason), and it buys little: an
 * attacker holding a high-entropy single-use link that expires in a week has it whatever
 * address they arrive with. Revocation, expiry and single use are the controls that matter.
 */
export const acceptInvitation = async (
  prisma: PrismaClient,
  params: { tokenHash: string; userId: string; now?: Date },
): Promise<AcceptOutcome> => {
  const now = params.now ?? new Date()

  const invitation = await prisma.invitation.findUnique({
    where: { tokenHash: params.tokenHash },
    select: {
      id: true,
      orgId: true,
      role: true,
      acceptedAt: true,
      revokedAt: true,
      expiresAt: true,
    },
  })
  if (!invitation) return { status: 'rejected', reason: 'unknown' }

  const state = invitationState(invitation, now)
  if (state !== 'pending') return { status: 'rejected', reason: state }

  // Conditional, so two people opening the same link race for one winner rather than both
  // being let in. A single-use invitation that is usable twice is not single-use.
  const { count } = await prisma.invitation.updateMany({
    where: { id: invitation.id, acceptedAt: null, revokedAt: null },
    data: { acceptedAt: now, acceptedBy: params.userId },
  })
  if (count === 0) return { status: 'rejected', reason: 'accepted' }

  const existing = await prisma.membership.findFirst({
    where: { orgId: invitation.orgId, userId: params.userId },
    select: { id: true },
  })
  if (existing) return { status: 'already-a-member', orgId: invitation.orgId }

  await prisma.membership.create({
    data: { orgId: invitation.orgId, userId: params.userId, role: invitation.role },
  })

  return { status: 'joined', orgId: invitation.orgId, role: invitation.role }
}

export const changeMemberRole = async (
  prisma: PrismaClient,
  orgId: string,
  userId: string,
  role: MemberRole,
): Promise<boolean> => {
  const { count } = await prisma.membership.updateMany({ where: { orgId, userId }, data: { role } })
  return count > 0
}

export const removeMember = async (
  prisma: PrismaClient,
  orgId: string,
  userId: string,
): Promise<boolean> => {
  const { count } = await prisma.membership.deleteMany({ where: { orgId, userId } })
  return count > 0
}
