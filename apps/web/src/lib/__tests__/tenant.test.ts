import { PrismaClient } from '@flakemetry/db'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'

import { listAccessibleProjects, requireProjectAccess } from '../tenant'

const hasDb = Boolean(process.env.DATABASE_URL)
const prisma = new PrismaClient()

const seedWorkspace = async (label: string) => {
  const user = await prisma.user.create({
    data: { name: label, email: `${label}-${Date.now()}@example.test` },
  })
  const org = await prisma.org.create({
    data: {
      name: `${label} org`,
      slug: `${label}-${Date.now()}`,
      memberships: { create: { userId: user.id, role: 'owner' } },
    },
  })
  const project = await prisma.project.create({
    data: { orgId: org.id, name: `${label} project`, slug: 'web' },
  })
  return { userId: user.id, orgId: org.id, projectId: project.id }
}

describe.skipIf(!hasDb)('tenant isolation', () => {
  beforeEach(async () => {
    await prisma.membership.deleteMany()
    await prisma.project.deleteMany()
    await prisma.org.deleteMany()
    await prisma.user.deleteMany()
  })

  afterAll(async () => {
    await prisma.$disconnect()
  })

  it('lists only the projects a user is a member of', async () => {
    const alice = await seedWorkspace('alice')
    await seedWorkspace('bob')

    const projects = await listAccessibleProjects(alice.userId)

    expect(projects).toHaveLength(1)
    expect(projects[0]?.id).toBe(alice.projectId)
    expect(projects[0]?.role).toBe('owner')
  })

  it('grants access to a project inside the user own org', async () => {
    const alice = await seedWorkspace('alice')

    const project = await requireProjectAccess(alice.userId, alice.projectId)

    expect(project.id).toBe(alice.projectId)
    expect(project.orgId).toBe(alice.orgId)
  })

  it('refuses a project belonging to another org', async () => {
    const alice = await seedWorkspace('alice')
    const bob = await seedWorkspace('bob')

    await expect(requireProjectAccess(alice.userId, bob.projectId)).rejects.toThrow(/NEXT_REDIRECT/)
  })

  it('refuses access once the membership is removed', async () => {
    const alice = await seedWorkspace('alice')
    await prisma.membership.deleteMany({ where: { userId: alice.userId } })

    await expect(requireProjectAccess(alice.userId, alice.projectId)).rejects.toThrow(
      /NEXT_REDIRECT/,
    )
    expect(await listAccessibleProjects(alice.userId)).toHaveLength(0)
  })

  it('sees a second project added to an org the user belongs to', async () => {
    const alice = await seedWorkspace('alice')
    await prisma.project.create({
      data: { orgId: alice.orgId, name: 'Second', slug: 'second' },
    })

    const projects = await listAccessibleProjects(alice.userId)

    expect(projects).toHaveLength(2)
  })
})
