'use server'

import { projectPolicyInputSchema } from '@flakemetry/contracts'
import { generateToken, getPrismaClient, hashToken } from '@flakemetry/db'
import { isEmailAddress, isSafeWebhookUrl } from '@flakemetry/notify'
import { splitIdentity, updateProjectPolicy as persistProjectPolicy } from '@flakemetry/queries'
import { revalidatePath } from 'next/cache'
import { cookies } from 'next/headers'
import { redirect } from 'next/navigation'

import { NOTIFY_EVENTS } from './notify-events'
import { requireUser } from './session'
import { requireProjectAccess } from './tenant'
import { NEW_TOKEN_COOKIE } from './token-cookie'

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

  const raw = generateToken()
  await prisma.ingestToken.create({
    data: { orgId: project.orgId, projectId: project.id, name, tokenHash: hashToken(raw) },
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

const CHANNEL_KINDS = ['slack', 'discord', 'email']

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
  })

  const { changed } = await persistProjectPolicy(prisma, { projectId, userId: user.id, input })

  revalidatePath(`/projects/${projectId}/settings/policy`)
  redirect(`/projects/${projectId}/settings/policy?saved=${changed.length}`)
}
