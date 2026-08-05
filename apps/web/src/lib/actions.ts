'use server'

import { randomUUID } from 'node:crypto'

import { projectPolicyInputSchema, TOKEN_SCOPES } from '@flakemetry/contracts'
import { generateToken, getPrismaClient, hashToken } from '@flakemetry/db'
import {
  generateWebhookSecret,
  isEmailAddress,
  isSafeWebhookUrl,
  isValidRepository,
} from '@flakemetry/notify'
import {
  acceptInvitation,
  changeMemberRole,
  checkInvite,
  checkRemoval,
  checkRoleChange,
  countOwners,
  createInvitation,
  isQuarantineDecision,
  type MemberRefusal,
  type MemberRole,
  mergeIdentities,
  recordRcaFeedback,
  removeMember,
  requestErasure,
  revokeInvitation,
  setClusterKnownIssue,
  setQuarantine,
  splitIdentity,
  unmergeIdentity,
  updateProjectPolicy as persistProjectPolicy,
} from '@flakemetry/queries'
import { orgArtifactPrefix, projectArtifactPrefix } from '@flakemetry/storage'
import { revalidatePath } from 'next/cache'
import { cookies } from 'next/headers'
import { redirect } from 'next/navigation'

import { checkErasureRequest, type ErasureRefusal } from './erasure-guard'
import { NOTIFY_EVENTS } from './notify-events'
import { requireUser } from './session'
import { requireProjectAccess } from './tenant'
import { NEW_INVITE_COOKIE, NEW_TOKEN_COOKIE } from './token-cookie'

const prisma = getPrismaClient()

const canManage = (role: string): boolean => role === 'owner' || role === 'admin'

const numberField = (formData: FormData, name: string, integer: boolean): number | null => {
  const raw = String(formData.get(name) ?? '').trim()
  if (raw === '') return null
  const value = integer ? Number.parseInt(raw, 10) : Number(raw)
  return Number.isFinite(value) ? value : null
}

const tristateField = (formData: FormData, name: string): boolean | null => {
  const raw = String(formData.get(name) ?? 'inherit')
  if (raw === 'on') return true
  if (raw === 'off') return false
  return null
}

const slugify = (value: string): string =>
  value
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48)

const uniqueOrgSlug = async (base: string): Promise<string> => {
  const seed = base || 'workspace'
  for (let suffix = 0; suffix < 50; suffix += 1) {
    const candidate = suffix === 0 ? seed : `${seed}-${suffix}`
    const taken = await prisma.org.findUnique({ where: { slug: candidate }, select: { id: true } })
    if (!taken) return candidate
  }
  throw new Error('could not allocate a unique workspace slug')
}

/** Slugs are unique per workspace, so a second project named like one in another
 * workspace is fine — but two "Web" projects side by side would collide, and Prisma
 * would surface that as a raw constraint error rather than anything a user can act on. */
const uniqueProjectSlug = async (orgId: string, base: string): Promise<string> => {
  const seed = base || 'project'
  for (let suffix = 0; suffix < 50; suffix += 1) {
    const candidate = suffix === 0 ? seed : `${seed}-${suffix}`
    const taken = await prisma.project.findFirst({
      where: { orgId, slug: candidate },
      select: { id: true },
    })
    if (!taken) return candidate
  }
  throw new Error('could not allocate a unique project slug')
}

export const createProject = async (formData: FormData): Promise<void> => {
  const user = await requireUser()
  const orgId = String(formData.get('orgId') ?? '')
  const name = String(formData.get('projectName') ?? '').trim()
  if (!name) throw new Error('project name is required')

  const membership = await prisma.membership.findFirst({
    where: { userId: user.id, orgId },
    select: { role: true },
  })
  if (!membership || !canManage(membership.role))
    throw new Error('only owners and admins can add a project')

  const project = await prisma.project.create({
    data: { orgId, name, slug: await uniqueProjectSlug(orgId, slugify(name)) },
    select: { id: true },
  })

  revalidatePath('/projects')
  redirect(`/projects/${project.id}/settings/tokens`)
}

export const createWorkspace = async (formData: FormData): Promise<void> => {
  const user = await requireUser()
  const orgName = String(formData.get('orgName') ?? '').trim()
  const projectName = String(formData.get('projectName') ?? '').trim()
  if (!orgName || !projectName) throw new Error('workspace and project name are required')

  const project = await prisma.$transaction(async (tx) => {
    const org = await tx.org.create({
      data: {
        name: orgName,
        slug: await uniqueOrgSlug(slugify(orgName)),
        memberships: { create: { userId: user.id, role: 'owner' } },
      },
      select: { id: true },
    })
    return tx.project.create({
      data: { orgId: org.id, name: projectName, slug: slugify(projectName) || 'default' },
      select: { id: true },
    })
  })

  redirect(`/projects/${project.id}/settings/tokens`)
}

export const createIngestToken = async (formData: FormData): Promise<void> => {
  const user = await requireUser()
  const projectId = String(formData.get('projectId') ?? '')
  const name = String(formData.get('name') ?? '').trim() || 'ci'
  const project = await requireProjectAccess(user.id, projectId)
  if (!canManage(project.role)) throw new Error('only owners and admins can manage ingest tokens')

  // Default to ingest alone. A token created without a deliberate choice should be able to
  // do the one thing tokens have always done, not everything the API offers.
  const requested = formData.getAll('scopes').map(String)
  const scopes = TOKEN_SCOPES.filter((scope) => requested.includes(scope))

  const raw = generateToken()
  await prisma.ingestToken.create({
    data: {
      orgId: project.orgId,
      projectId: project.id,
      name,
      tokenHash: hashToken(raw),
      scopes: scopes.length > 0 ? scopes : ['ingest'],
    },
  })

  const store = await cookies()
  store.set(NEW_TOKEN_COOKIE, raw, {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    path: `/projects/${projectId}/settings/tokens`,
    maxAge: 120,
  })

  revalidatePath(`/projects/${projectId}/settings/tokens`)
  redirect(`/projects/${projectId}/settings/tokens?created=1`)
}

export const revokeIngestToken = async (formData: FormData): Promise<void> => {
  const user = await requireUser()
  const projectId = String(formData.get('projectId') ?? '')
  const tokenId = String(formData.get('tokenId') ?? '')
  const project = await requireProjectAccess(user.id, projectId)
  if (!canManage(project.role)) throw new Error('only owners and admins can manage ingest tokens')

  await prisma.ingestToken.updateMany({
    where: { id: tokenId, projectId, revokedAt: null },
    data: { revokedAt: new Date() },
  })

  revalidatePath(`/projects/${projectId}/settings/tokens`)
}

const CHANNEL_KINDS = ['slack', 'discord', 'email', 'webhook']

const isValidTarget = (kind: string, target: string): boolean =>
  kind === 'email' ? isEmailAddress(target) : isSafeWebhookUrl(target)

export const createNotificationChannel = async (formData: FormData): Promise<void> => {
  const user = await requireUser()
  const projectId = String(formData.get('projectId') ?? '')
  const project = await requireProjectAccess(user.id, projectId)
  if (!canManage(project.role)) throw new Error('only owners and admins can manage notifications')

  const kind = String(formData.get('kind') ?? '')
  const target = String(formData.get('target') ?? '').trim()
  const events = NOTIFY_EVENTS.filter((event) => formData.get(`event:${event}`) === 'on')
  if (!CHANNEL_KINDS.includes(kind) || !isValidTarget(kind, target)) {
    throw new Error('a channel needs a kind and a public https webhook URL or email address')
  }

  await prisma.notificationChannel.create({
    data: {
      orgId: project.orgId,
      projectId,
      kind,
      target,
      // Generated here, never taken from the form. A caller-chosen signing secret is one
      // the caller can also forge deliveries with.
      ...(kind === 'webhook' ? { secret: generateWebhookSecret() } : {}),
      events: events.length > 0 ? events : NOTIFY_EVENTS,
    },
  })

  revalidatePath(`/projects/${projectId}/settings/notifications`)
}

export const deleteNotificationChannel = async (formData: FormData): Promise<void> => {
  const user = await requireUser()
  const projectId = String(formData.get('projectId') ?? '')
  const channelId = String(formData.get('channelId') ?? '')
  const project = await requireProjectAccess(user.id, projectId)
  if (!canManage(project.role)) throw new Error('only owners and admins can manage notifications')

  await prisma.notificationChannel.deleteMany({
    where: { id: channelId, projectId, source: 'dashboard' },
  })
  revalidatePath(`/projects/${projectId}/settings/notifications`)
}

export const splitTestIdentity = async (formData: FormData): Promise<void> => {
  const user = await requireUser()
  const projectId = String(formData.get('projectId') ?? '')
  const testId = String(formData.get('testId') ?? '')
  const fingerprint = String(formData.get('fingerprint') ?? '')
  const project = await requireProjectAccess(user.id, projectId)
  if (!canManage(project.role)) throw new Error('only owners and admins can split a test identity')

  const outcome = await splitIdentity(prisma, {
    orgId: project.orgId,
    projectId,
    sourceIdentityId: testId,
    fingerprint,
    userId: user.id,
  })

  revalidatePath(`/projects/${projectId}/tests/${testId}`)
  if (outcome.status === 'rejected')
    redirect(`/projects/${projectId}/tests/${testId}?split=${encodeURIComponent(outcome.reason)}`)
  redirect(`/projects/${projectId}/tests/${outcome.targetIdentityId}`)
}

export const mergeTestIdentity = async (formData: FormData): Promise<void> => {
  const user = await requireUser()
  const projectId = String(formData.get('projectId') ?? '')
  const testId = String(formData.get('testId') ?? '')
  const sourceId = String(formData.get('sourceId') ?? '')
  const project = await requireProjectAccess(user.id, projectId)
  if (!canManage(project.role)) throw new Error('only owners and admins can merge test identities')

  const outcome = await mergeIdentities(prisma, {
    orgId: project.orgId,
    projectId,
    targetIdentityId: testId,
    sourceIdentityId: sourceId,
    userId: user.id,
  })

  revalidatePath(`/projects/${projectId}/tests/${testId}`)
  if (outcome.status === 'rejected')
    redirect(`/projects/${projectId}/tests/${testId}?split=${encodeURIComponent(outcome.reason)}`)
  redirect(`/projects/${projectId}/tests/${testId}`)
}

export const unmergeTestIdentity = async (formData: FormData): Promise<void> => {
  const user = await requireUser()
  const projectId = String(formData.get('projectId') ?? '')
  const testId = String(formData.get('testId') ?? '')
  const project = await requireProjectAccess(user.id, projectId)
  if (!canManage(project.role)) throw new Error('only owners and admins can undo a merge')

  const outcome = await unmergeIdentity(prisma, {
    orgId: project.orgId,
    projectId,
    targetIdentityId: testId,
    userId: user.id,
  })

  revalidatePath(`/projects/${projectId}/tests/${testId}`)
  if (outcome.status === 'rejected')
    redirect(`/projects/${projectId}/tests/${testId}?split=${encodeURIComponent(outcome.reason)}`)
  redirect(`/projects/${projectId}/tests/${testId}`)
}

export const updateProjectPolicy = async (formData: FormData): Promise<void> => {
  const user = await requireUser()
  const projectId = String(formData.get('projectId') ?? '')
  const project = await requireProjectAccess(user.id, projectId)
  if (!canManage(project.role)) throw new Error('only owners and admins can edit policy')

  const input = projectPolicyInputSchema.parse({
    flakyThreshold: numberField(formData, 'flakyThreshold', false),
    minSamples: numberField(formData, 'minSamples', true),
    quarantineEnabled: tristateField(formData, 'quarantineEnabled'),
    quarantineCooldownRuns: numberField(formData, 'quarantineCooldownRuns', true),
    aiRcaEnabled: tristateField(formData, 'aiRcaEnabled'),
    executionRetentionDays: numberField(formData, 'executionRetentionDays', true),
    artifactRetentionDays: numberField(formData, 'artifactRetentionDays', true),
    ciMinuteCost: numberField(formData, 'ciMinuteCost', false),
    developerHourCost: numberField(formData, 'developerHourCost', false),
    investigationMinutes: numberField(formData, 'investigationMinutes', true),
    trackerEnabled: tristateField(formData, 'trackerEnabled'),
    trackerAfterDays: numberField(formData, 'trackerAfterDays', true),
    trackerRecoveryDays: numberField(formData, 'trackerRecoveryDays', true),
  })

  const { changed } = await persistProjectPolicy(prisma, { projectId, userId: user.id, input })

  revalidatePath(`/projects/${projectId}/settings/policy`)
  redirect(`/projects/${projectId}/settings/policy?saved=${changed.length}`)
}

export const updateProjectRepository = async (formData: FormData): Promise<void> => {
  const user = await requireUser()
  const projectId = String(formData.get('projectId') ?? '')
  const raw = String(formData.get('repository') ?? '').trim()
  const project = await requireProjectAccess(user.id, projectId)
  if (!canManage(project.role)) throw new Error('only owners and admins can set the repository')
  if (raw && !isValidRepository(raw)) {
    throw new Error('repository must look like owner/name')
  }

  await prisma.project.update({
    where: { id: projectId },
    data: { repository: raw ? raw : null },
  })

  revalidatePath(`/projects/${projectId}/settings/policy`)
  redirect(`/projects/${projectId}/settings/policy?repository=saved`)
}

export const rotateBadgeToken = async (formData: FormData): Promise<void> => {
  const user = await requireUser()
  const projectId = String(formData.get('projectId') ?? '')
  const project = await requireProjectAccess(user.id, projectId)
  if (!canManage(project.role)) throw new Error('only owners and admins can manage badges')

  // Rotating invalidates every README already pointing at the old one, which is the point:
  // the token is a public capability, so revoking it has to be possible.
  await prisma.project.update({
    where: { id: projectId },
    data: { badgeToken: `bdg_${randomUUID()}` },
  })

  revalidatePath(`/projects/${projectId}/settings/badges`)
  redirect(`/projects/${projectId}/settings/badges`)
}

export const disableBadges = async (formData: FormData): Promise<void> => {
  const user = await requireUser()
  const projectId = String(formData.get('projectId') ?? '')
  const project = await requireProjectAccess(user.id, projectId)
  if (!canManage(project.role)) throw new Error('only owners and admins can manage badges')

  await prisma.project.update({ where: { id: projectId }, data: { badgeToken: null } })

  revalidatePath(`/projects/${projectId}/settings/badges`)
  redirect(`/projects/${projectId}/settings/badges`)
}

export const updateClusterKnownIssue = async (formData: FormData): Promise<void> => {
  const user = await requireUser()
  const projectId = String(formData.get('projectId') ?? '')
  const testId = String(formData.get('testId') ?? '')
  const clusterId = String(formData.get('clusterId') ?? '')
  const knownIssueRef = String(formData.get('knownIssueRef') ?? '')
  const project = await requireProjectAccess(user.id, projectId)
  if (!canManage(project.role))
    throw new Error('only owners and admins can mark a cluster as a known issue')

  await setClusterKnownIssue(prisma, projectId, clusterId, knownIssueRef)

  revalidatePath(`/projects/${projectId}/tests/${testId}`)
}

const refuseErasure = (refusal: ErasureRefusal | null, subject: string, expected: string): void => {
  if (refusal === 'not-owner') {
    throw new Error(`only the workspace owner can delete a ${subject}`)
  }
  if (refusal === 'confirmation-mismatch') {
    throw new Error(`type ${expected} to confirm the deletion`)
  }
}

export const requestProjectErasure = async (formData: FormData): Promise<void> => {
  const user = await requireUser()
  const projectId = String(formData.get('projectId') ?? '')
  const project = await requireProjectAccess(user.id, projectId)

  refuseErasure(
    checkErasureRequest({
      role: project.role,
      typed: String(formData.get('confirm') ?? ''),
      expected: project.slug,
    }),
    'project',
    project.slug,
  )

  await requestErasure(prisma, {
    target: {
      kind: 'project',
      id: project.id,
      orgId: project.orgId,
      artifactPrefix: projectArtifactPrefix(project.orgId, project.id),
    },
    subject: `project "${project.name}" (${project.slug})`,
    actor: user.email ?? user.id,
    actorUserId: user.id,
  })

  revalidatePath(`/projects/${projectId}/settings/data`)
  redirect(`/projects/${projectId}/settings/data?requested=project`)
}

export const requestWorkspaceErasure = async (formData: FormData): Promise<void> => {
  const user = await requireUser()
  const projectId = String(formData.get('projectId') ?? '')
  const project = await requireProjectAccess(user.id, projectId)

  refuseErasure(
    checkErasureRequest({
      role: project.role,
      typed: String(formData.get('confirm') ?? ''),
      expected: project.orgSlug,
    }),
    'workspace',
    project.orgSlug,
  )

  await requestErasure(prisma, {
    target: {
      kind: 'org',
      id: project.orgId,
      orgId: project.orgId,
      artifactPrefix: orgArtifactPrefix(project.orgId),
    },
    subject: `workspace "${project.orgName}" (${project.orgSlug})`,
    actor: user.email ?? user.id,
    actorUserId: user.id,
  })

  redirect('/projects')
}

const REFUSAL: Record<MemberRefusal, string> = {
  'not-a-manager': 'only owners and admins can manage members',
  'owner-only': 'only the workspace owner can do that',
  'last-owner': 'a workspace has to keep at least one owner',
  'unknown-role': 'unknown role',
}

const refuse = (refusal: MemberRefusal | null): void => {
  if (refusal) throw new Error(REFUSAL[refusal])
}

export const inviteMember = async (formData: FormData): Promise<void> => {
  const user = await requireUser()
  const projectId = String(formData.get('projectId') ?? '')
  const email = String(formData.get('email') ?? '')
    .trim()
    .toLowerCase()
  const role = String(formData.get('role') ?? 'member')
  const project = await requireProjectAccess(user.id, projectId)

  refuse(checkInvite({ actorRole: project.role, invitedRole: role }))
  if (!isEmailAddress(email)) throw new Error('an invitation needs an email address')

  const raw = generateToken()
  await createInvitation(prisma, {
    orgId: project.orgId,
    email,
    role: role as MemberRole,
    invitedBy: user.id,
    tokenHash: hashToken(raw),
  })

  // Same handling as a new ingest token: shown once, over a short-lived httpOnly cookie, so
  // the link never lands in a URL that a proxy log or a browser history would keep.
  const store = await cookies()
  store.set(NEW_INVITE_COOKIE, raw, {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    path: `/projects/${projectId}/settings/members`,
    maxAge: 120,
  })

  revalidatePath(`/projects/${projectId}/settings/members`)
  redirect(`/projects/${projectId}/settings/members?invited=1`)
}

export const cancelInvitation = async (formData: FormData): Promise<void> => {
  const user = await requireUser()
  const projectId = String(formData.get('projectId') ?? '')
  const invitationId = String(formData.get('invitationId') ?? '')
  const project = await requireProjectAccess(user.id, projectId)
  if (!canManage(project.role)) throw new Error('only owners and admins can manage members')

  await revokeInvitation(prisma, project.orgId, invitationId)

  revalidatePath(`/projects/${projectId}/settings/members`)
}

export const updateMemberRole = async (formData: FormData): Promise<void> => {
  const user = await requireUser()
  const projectId = String(formData.get('projectId') ?? '')
  const userId = String(formData.get('userId') ?? '')
  const newRole = String(formData.get('role') ?? '')
  const project = await requireProjectAccess(user.id, projectId)

  const target = await prisma.membership.findFirst({
    where: { orgId: project.orgId, userId },
    select: { role: true },
  })
  if (!target) throw new Error('that person is not in this workspace')

  refuse(
    checkRoleChange({
      actorRole: project.role,
      targetRole: target.role,
      newRole,
      ownerCount: await countOwners(prisma, project.orgId),
    }),
  )

  await changeMemberRole(prisma, project.orgId, userId, newRole as MemberRole)

  revalidatePath(`/projects/${projectId}/settings/members`)
}

export const removeMemberFromWorkspace = async (formData: FormData): Promise<void> => {
  const user = await requireUser()
  const projectId = String(formData.get('projectId') ?? '')
  const userId = String(formData.get('userId') ?? '')
  const project = await requireProjectAccess(user.id, projectId)

  const target = await prisma.membership.findFirst({
    where: { orgId: project.orgId, userId },
    select: { role: true },
  })
  if (!target) throw new Error('that person is not in this workspace')

  refuse(
    checkRemoval({
      actorRole: project.role,
      targetRole: target.role,
      ownerCount: await countOwners(prisma, project.orgId),
    }),
  )

  await removeMember(prisma, project.orgId, userId)

  // Removing themselves means they can no longer read this page.
  if (userId === user.id) redirect('/projects')
  revalidatePath(`/projects/${projectId}/settings/members`)
}

export const acceptInvite = async (formData: FormData): Promise<void> => {
  const user = await requireUser()
  const token = String(formData.get('token') ?? '')

  const outcome = await acceptInvitation(prisma, { tokenHash: hashToken(token), userId: user.id })
  if (outcome.status === 'rejected') {
    redirect(`/invite/${encodeURIComponent(token)}?error=${outcome.reason}`)
  }

  redirect('/projects')
}

export const setTestQuarantine = async (formData: FormData): Promise<void> => {
  const user = await requireUser()
  const projectId = String(formData.get('projectId') ?? '')
  const testId = String(formData.get('testId') ?? '')
  const decision = String(formData.get('decision') ?? '')
  const project = await requireProjectAccess(user.id, projectId)
  if (!canManage(project.role))
    throw new Error('only owners and admins can change quarantine state')
  if (!isQuarantineDecision(decision)) throw new Error('unknown quarantine decision')

  await setQuarantine(prisma, {
    orgId: project.orgId,
    projectId,
    testIdentityId: testId,
    decision,
    reason: String(formData.get('reason') ?? ''),
    userId: user.id,
  })

  revalidatePath(`/projects/${projectId}/tests/${testId}`)
  redirect(`/projects/${projectId}/tests/${testId}`)
}

export const submitRcaFeedback = async (formData: FormData): Promise<void> => {
  const user = await requireUser()
  const projectId = String(formData.get('projectId') ?? '')
  const testId = String(formData.get('testId') ?? '')
  const reportId = String(formData.get('reportId') ?? '')
  const verdict = String(formData.get('verdict') ?? '')
  const correction = String(formData.get('correction') ?? '')
  if (verdict !== 'helpful' && verdict !== 'unhelpful') throw new Error('unknown verdict')

  const project = await requireProjectAccess(user.id, projectId)

  await recordRcaFeedback(prisma, {
    orgId: project.orgId,
    projectId,
    reportId,
    userId: user.id,
    verdict,
    correction,
  })

  revalidatePath(`/projects/${projectId}/tests/${testId}`)
}
