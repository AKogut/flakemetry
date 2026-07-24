import { PrismaClient } from '@flakemetry/db'
import {
  getEffectiveProjectPolicy,
  listPolicyChanges,
  updateProjectPolicy,
} from '@flakemetry/queries'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'

const hasDb = Boolean(process.env.DATABASE_URL)
const prisma = new PrismaClient()

const seed = async () => {
  const org = await prisma.org.create({ data: { name: 'Acme', slug: `acme-${Date.now()}` } })
  const project = await prisma.project.create({
    data: { orgId: org.id, name: 'Web', slug: `web-${Date.now()}` },
  })
  const user = await prisma.user.create({
    data: { name: 'Andrii', email: `andrii-${Date.now()}@example.test` },
  })
  return { orgId: org.id, projectId: project.id, userId: user.id }
}

describe.skipIf(!hasDb)('project policy queries', () => {
  beforeEach(async () => {
    await prisma.policyChange.deleteMany()
    await prisma.projectPolicy.deleteMany()
    await prisma.project.deleteMany()
    await prisma.org.deleteMany()
    await prisma.user.deleteMany()
  })

  afterAll(async () => {
    await prisma.$disconnect()
  })

  it('returns defaults with a "default" source when no row exists', async () => {
    const { projectId } = await seed()
    const { effective, stored } = await getEffectiveProjectPolicy(prisma, projectId, {})
    expect(stored).toEqual({})
    expect(effective.flakyThreshold).toEqual({ value: 0.8, source: 'default' })
  })

  it('persists a change and records one audit row per changed field', async () => {
    const { projectId, userId } = await seed()
    const { changed } = await updateProjectPolicy(prisma, {
      projectId,
      userId,
      input: { flakyThreshold: 0.6, minSamples: 3 },
    })
    expect(changed.sort()).toEqual(['flakyThreshold', 'minSamples'])

    const { effective } = await getEffectiveProjectPolicy(prisma, projectId, {})
    expect(effective.flakyThreshold).toEqual({ value: 0.6, source: 'ui' })
    expect(effective.minSamples).toEqual({ value: 3, source: 'ui' })

    const changes = await listPolicyChanges(prisma, projectId)
    expect(changes).toHaveLength(2)
    const threshold = changes.find((c) => c.field === 'flakyThreshold')
    expect(threshold).toMatchObject({ oldValue: null, newValue: '0.6', actor: 'Andrii' })
  })

  it('records nothing when the submitted values are unchanged', async () => {
    const { projectId, userId } = await seed()
    await updateProjectPolicy(prisma, { projectId, userId, input: { flakyThreshold: 0.6 } })
    const second = await updateProjectPolicy(prisma, {
      projectId,
      userId,
      input: { flakyThreshold: 0.6 },
    })
    expect(second.changed).toEqual([])
    expect(await listPolicyChanges(prisma, projectId)).toHaveLength(1)
  })

  it('records clearing a field back to the default', async () => {
    const { projectId, userId } = await seed()
    await updateProjectPolicy(prisma, { projectId, userId, input: { flakyThreshold: 0.6 } })
    const { changed } = await updateProjectPolicy(prisma, {
      projectId,
      userId,
      input: { flakyThreshold: null },
    })
    expect(changed).toEqual(['flakyThreshold'])

    const { stored, effective } = await getEffectiveProjectPolicy(prisma, projectId, {})
    expect(stored.flakyThreshold).toBeUndefined()
    expect(effective.flakyThreshold.source).toBe('default')

    const latest = (await listPolicyChanges(prisma, projectId))[0]
    expect(latest).toMatchObject({ field: 'flakyThreshold', oldValue: '0.6', newValue: null })
  })

  it('lets an env override outrank the stored UI value', async () => {
    const { projectId, userId } = await seed()
    await updateProjectPolicy(prisma, { projectId, userId, input: { flakyThreshold: 0.6 } })
    const { effective } = await getEffectiveProjectPolicy(prisma, projectId, {
      FLAKEMETRY_FLAKY_THRESHOLD: '0.95',
    })
    expect(effective.flakyThreshold).toEqual({ value: 0.95, source: 'env' })
  })
})
