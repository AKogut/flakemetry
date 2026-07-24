'use server'

import { projectPolicyInputSchema } from '@flakemetry/contracts'
import { generateToken, getPrismaClient, hashToken } from '@flakemetry/db'
import { updateProjectPolicy as persistProjectPolicy } from '@flakemetry/queries'
import { revalidatePath } from 'next/cache'
import { redirect } from 'next/navigation'

import { requireUser } from './session'
import { requireProjectAccess } from './tenant'

const prisma = getPrismaClient()

const canEditPolicy = (role: string): boolean => role === 'owner' || role === 'admin'

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

  const raw = generateToken()
  await prisma.ingestToken.create({
    data: { orgId: project.orgId, projectId: project.id, name, tokenHash: hashToken(raw) },
  })

  revalidatePath(`/projects/${projectId}/settings/tokens`)
  redirect(`/projects/${projectId}/settings/tokens?created=${encodeURIComponent(raw)}`)
}

export const revokeIngestToken = async (formData: FormData): Promise<void> => {
  const user = await requireUser()
  const projectId = String(formData.get('projectId') ?? '')
  const tokenId = String(formData.get('tokenId') ?? '')
  await requireProjectAccess(user.id, projectId)

  await prisma.ingestToken.updateMany({
    where: { id: tokenId, projectId, revokedAt: null },
    data: { revokedAt: new Date() },
  })

  revalidatePath(`/projects/${projectId}/settings/tokens`)
}

export const updateProjectPolicy = async (formData: FormData): Promise<void> => {
  const user = await requireUser()
  const projectId = String(formData.get('projectId') ?? '')
  const project = await requireProjectAccess(user.id, projectId)
  if (!canEditPolicy(project.role)) throw new Error('only owners and admins can edit policy')

  const input = projectPolicyInputSchema.parse({
    flakyThreshold: numberField(formData, 'flakyThreshold', false),
    minSamples: numberField(formData, 'minSamples', true),
    quarantineEnabled: tristateField(formData, 'quarantineEnabled'),
    quarantineCooldownRuns: numberField(formData, 'quarantineCooldownRuns', true),
    aiRcaEnabled: tristateField(formData, 'aiRcaEnabled'),
  })

  const { changed } = await persistProjectPolicy(prisma, { projectId, userId: user.id, input })

  revalidatePath(`/projects/${projectId}/settings/policy`)
  redirect(`/projects/${projectId}/settings/policy?saved=${changed.length}`)
}
