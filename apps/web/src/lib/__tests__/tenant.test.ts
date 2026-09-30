import { createPrismaClient } from '@flakemetry/db'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'

import { listAccessibleProjects, requireProjectAccess } from '../tenant'

const hasDb = Boolean(process.env.DATABASE_URL)
const prisma = createPrismaClient()

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
    await prisma.projectGrant.deleteMany()
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

  describe('restricted projects', () => {
    const joinAs = async (orgId: string, role: 'member' | 'viewer') => {
      const user = await prisma.user.create({
        data: { name: role, email: `${role}-${Math.random()}@example.test` },
      })
      await prisma.membership.create({ data: { orgId, userId: user.id, role } })
      return user.id
    }

    it('hides a restricted project from a member without a grant, on the list and by id', async () => {
      const alice = await seedWorkspace('alice')
      await prisma.project.update({ where: { id: alice.projectId }, data: { restricted: true } })
      const open = await prisma.project.create({
        data: { orgId: alice.orgId, name: 'Open', slug: 'open' },
      })
      const member = await joinAs(alice.orgId, 'member')

      expect((await listAccessibleProjects(member)).map((project) => project.id)).toEqual([open.id])
      await expect(requireProjectAccess(member, alice.projectId)).rejects.toThrow(/NEXT_REDIRECT/)
      expect((await requireProjectAccess(alice.userId, alice.projectId)).role).toBe('owner')
    })

    it('opens a restricted project to a grant, with the role of the grant', async () => {
      const alice = await seedWorkspace('alice')
      await prisma.project.update({ where: { id: alice.projectId }, data: { restricted: true } })
      const viewer = await joinAs(alice.orgId, 'viewer')
      await prisma.projectGrant.create({
        data: { orgId: alice.orgId, projectId: alice.projectId, userId: viewer, role: 'member' },
      })

      const project = await requireProjectAccess(viewer, alice.projectId)

      expect(project.role).toBe('member')
      expect(project.orgRole).toBe('viewer')
    })

    it('ignores a grant on a project in another workspace', async () => {
      const alice = await seedWorkspace('alice')
      const bob = await seedWorkspace('bob')
      await prisma.project.update({ where: { id: bob.projectId }, data: { restricted: true } })
      await prisma.projectGrant.create({
        data: { orgId: bob.orgId, projectId: bob.projectId, userId: alice.userId, role: 'member' },
      })

      await expect(requireProjectAccess(alice.userId, bob.projectId)).rejects.toThrow(
        /NEXT_REDIRECT/,
      )
    })
  })
})
