import { PrismaClient } from '@flakemetry/db'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'

import { adoptUnclaimedOrgs } from '../bootstrap'

const hasDb = Boolean(process.env.DATABASE_URL)
const prisma = new PrismaClient()

const makeUser = (label: string) =>
  prisma.user.create({ data: { name: label, email: `${label}-${Date.now()}@example.test` } })

const makeOrg = (label: string) =>
  prisma.org.create({ data: { name: label, slug: `${label}-${Date.now()}` } })

describe.skipIf(!hasDb)('first-user bootstrap', () => {
  beforeEach(async () => {
    await prisma.membership.deleteMany()
    await prisma.project.deleteMany()
    await prisma.org.deleteMany()
    await prisma.user.deleteMany()
  })

  afterAll(async () => {
    await prisma.$disconnect()
  })

  it('adopts seeded orgs that have no members yet', async () => {
    const org = await makeOrg('seeded')
    const user = await makeUser('first')

    expect(await adoptUnclaimedOrgs(prisma, user.id)).toBe(1)

    const membership = await prisma.membership.findFirstOrThrow({ where: { userId: user.id } })
    expect(membership.orgId).toBe(org.id)
    expect(membership.role).toBe('owner')
  })

  it('adopts nothing once the instance already has a member', async () => {
    const owner = await makeUser('owner')
    const claimed = await makeOrg('claimed')
    await prisma.membership.create({ data: { userId: owner.id, orgId: claimed.id, role: 'owner' } })
    await makeOrg('later-seeded')

    const newcomer = await makeUser('newcomer')
    expect(await adoptUnclaimedOrgs(prisma, newcomer.id)).toBe(0)
    expect(await prisma.membership.count({ where: { userId: newcomer.id } })).toBe(0)
  })

  it('never takes an org that already belongs to someone', async () => {
    const owner = await makeUser('owner')
    const org = await makeOrg('private')
    await prisma.membership.create({ data: { userId: owner.id, orgId: org.id, role: 'owner' } })

    const stranger = await makeUser('stranger')
    await adoptUnclaimedOrgs(prisma, stranger.id)

    const members = await prisma.membership.findMany({ where: { orgId: org.id } })
    expect(members).toHaveLength(1)
    expect(members[0]?.userId).toBe(owner.id)
  })

  it('is a no-op when there is nothing to adopt', async () => {
    const user = await makeUser('solo')
    expect(await adoptUnclaimedOrgs(prisma, user.id)).toBe(0)
  })
})
