import {
  type EffectiveProjectPolicy,
  normalizePolicyOverrides,
  POLICY_FIELDS,
  type PolicyField,
  projectPolicyEnvOverrides,
  type ProjectPolicyInput,
  type ProjectPolicyValues,
  resolveProjectPolicy,
} from '@flakemetry/contracts'
import type { PrismaClient } from '@flakemetry/db'

export interface ProjectPolicyView {
  effective: EffectiveProjectPolicy
  stored: Partial<ProjectPolicyValues>
}

export interface PolicyChangeEntry {
  id: string
  field: PolicyField
  oldValue: string | null
  newValue: string | null
  createdAt: Date
  actor: string | null
}

type StoredValue = number | boolean | null

const storedField = (row: Record<string, unknown> | null, field: PolicyField): StoredValue => {
  if (!row) return null
  const value = row[field]
  if (typeof value === 'number' || typeof value === 'boolean') return value
  return null
}

const serialize = (value: StoredValue): string | null => (value === null ? null : String(value))

export const getEffectiveProjectPolicy = async (
  prisma: PrismaClient,
  projectId: string,
  env: Record<string, string | undefined> = process.env,
): Promise<ProjectPolicyView> => {
  const row = await prisma.projectPolicy.findUnique({ where: { projectId } })
  const stored = normalizePolicyOverrides(row)
  const effective = resolveProjectPolicy({ ui: stored, env: projectPolicyEnvOverrides(env) })
  return { effective, stored }
}

export const listPolicyChanges = async (
  prisma: PrismaClient,
  projectId: string,
  limit = 20,
): Promise<PolicyChangeEntry[]> => {
  const rows = await prisma.policyChange.findMany({
    where: { projectId },
    orderBy: { createdAt: 'desc' },
    take: limit,
    select: {
      id: true,
      field: true,
      oldValue: true,
      newValue: true,
      createdAt: true,
      user: { select: { name: true, email: true } },
    },
  })
  return rows.map((row) => ({
    id: row.id,
    field: row.field as PolicyField,
    oldValue: row.oldValue,
    newValue: row.newValue,
    createdAt: row.createdAt,
    actor: row.user?.name ?? row.user?.email ?? null,
  }))
}

export interface UpdatePolicyParams {
  projectId: string
  userId: string | null
  input: ProjectPolicyInput
}

export const updateProjectPolicy = async (
  prisma: PrismaClient,
  params: UpdatePolicyParams,
): Promise<{ changed: PolicyField[] }> => {
  const { projectId, userId, input } = params
  const project = await prisma.project.findUniqueOrThrow({
    where: { id: projectId },
    select: { orgId: true },
  })

  const existing = (await prisma.projectPolicy.findUnique({ where: { projectId } })) as Record<
    string,
    unknown
  > | null

  const nextValues: Record<string, StoredValue> = {}
  const changes: { field: PolicyField; oldValue: string | null; newValue: string | null }[] = []

  for (const field of POLICY_FIELDS) {
    const previous = storedField(existing, field)
    const next = field in input ? ((input[field] ?? null) as StoredValue) : previous
    nextValues[field] = next
    if (next !== previous)
      changes.push({ field, oldValue: serialize(previous), newValue: serialize(next) })
  }

  if (changes.length === 0) return { changed: [] }

  await prisma.$transaction([
    prisma.projectPolicy.upsert({
      where: { projectId },
      create: { projectId, orgId: project.orgId, ...nextValues },
      update: nextValues,
    }),
    prisma.policyChange.createMany({
      data: changes.map((change) => ({
        orgId: project.orgId,
        projectId,
        userId,
        field: change.field,
        oldValue: change.oldValue,
        newValue: change.newValue,
      })),
    }),
  ])

  return { changed: changes.map((change) => change.field) }
}
