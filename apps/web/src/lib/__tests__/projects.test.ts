import { randomUUID } from 'node:crypto'

import { PrismaClient } from '@flakemetry/db'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'

const hasDb = Boolean(process.env.DATABASE_URL)
const prisma = new PrismaClient()

const slugify = (value: string): string =>
  value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')

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

describe.skipIf(!hasDb)('adding projects to a workspace', () => {
  beforeEach(async () => {
    await prisma.membership.deleteMany()
    await prisma.project.deleteMany()
    await prisma.org.deleteMany()
    await prisma.user.deleteMany()
  })

  afterAll(async () => {
    await prisma.$disconnect()
  })

  it('allocates a distinct slug for a second project of the same name', async () => {
    const org = await prisma.org.create({ data: { name: 'Acme', slug: `acme-${randomUUID()}` } })
    await prisma.project.create({
      data: { orgId: org.id, name: 'Web', slug: await uniqueProjectSlug(org.id, slugify('Web')) },
    })

    // Project slugs are unique per workspace. Onboarding a second suite that happens to
    // be called the same thing must not fail on a raw constraint error.
    const second = await uniqueProjectSlug(org.id, slugify('Web'))
    expect(second).toBe('web-1')

    await expect(
      prisma.project.create({ data: { orgId: org.id, name: 'Web', slug: second } }),
    ).resolves.toBeTruthy()
  })

  it('lets the same slug live in a different workspace', async () => {
    const first = await prisma.org.create({ data: { name: 'A', slug: `a-${randomUUID()}` } })
    const second = await prisma.org.create({ data: { name: 'B', slug: `b-${randomUUID()}` } })
    await prisma.project.create({ data: { orgId: first.id, name: 'Web', slug: 'web' } })

    expect(await uniqueProjectSlug(second.id, 'web')).toBe('web')
  })

  it('keeps every project of a workspace reachable', async () => {
    const org = await prisma.org.create({ data: { name: 'Acme', slug: `acme-${randomUUID()}` } })
    const user = await prisma.user.create({
      data: { name: 'owner', email: `owner-${randomUUID()}@example.test` },
    })
    await prisma.membership.create({ data: { userId: user.id, orgId: org.id, role: 'owner' } })
    for (const name of ['Web', 'Api', 'Mobile']) {
      await prisma.project.create({
        data: { orgId: org.id, name, slug: await uniqueProjectSlug(org.id, slugify(name)) },
      })
    }

    const { listAccessibleProjects } = await import('../tenant')
    const visible = await listAccessibleProjects(user.id)

    // The home page used to send everyone to projects[0] with no way back, so a second
    // project could exist and never be opened.
    expect(visible.map((project) => project.name).sort()).toEqual(['Api', 'Mobile', 'Web'])
  })
})
