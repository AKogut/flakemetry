import { execFileSync } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { PrismaClient } from '@prisma/client'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'

const hasDb = Boolean(process.env.DATABASE_URL)
const prisma = new PrismaClient()

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..')

const runSeed = (...args: string[]) =>
  execFileSync('pnpm', ['exec', 'tsx', join(packageRoot, 'prisma', 'seed.ts'), ...args], {
    cwd: packageRoot,
    encoding: 'utf8',
    env: { ...process.env },
  })

describe.skipIf(!hasDb)('demo seed', () => {
  beforeEach(async () => {
    await prisma.membership.deleteMany()
    await prisma.project.deleteMany()
    await prisma.org.deleteMany()
    await prisma.user.deleteMany()
  })

  afterAll(async () => {
    await prisma.$disconnect()
  })

  it('seeds the demo dataset into an empty database', async () => {
    runSeed()

    expect(await prisma.org.count()).toBe(1)
    expect(await prisma.run.count()).toBeGreaterThan(0)
    expect(await prisma.testExecution.count()).toBeGreaterThan(0)
  })

  it('leaves an already-populated database alone', async () => {
    const org = await prisma.org.create({ data: { name: 'Real', slug: `real-${Date.now()}` } })
    const project = await prisma.project.create({
      data: { orgId: org.id, name: 'Web', slug: 'web' },
    })

    // The docker-compose migrate step runs this on every `up`, so an unguarded
    // seed would wipe everything the user ingested between restarts.
    const output = runSeed()
    expect(output).toContain('leaving it untouched')

    expect(await prisma.project.findUnique({ where: { id: project.id } })).not.toBeNull()
    expect(await prisma.org.count()).toBe(1)
  })

  it('keeps a signed-in member attached across a restart', async () => {
    runSeed()
    const org = await prisma.org.findFirstOrThrow()
    const user = await prisma.user.create({
      data: { name: 'tester', email: `tester-${Date.now()}@example.test` },
    })
    await prisma.membership.create({ data: { userId: user.id, orgId: org.id, role: 'owner' } })

    runSeed()

    // Deleting the org cascades the membership away, locking the tester out of an
    // instance they can no longer repair from the dashboard.
    expect(await prisma.membership.count({ where: { userId: user.id } })).toBe(1)
  })

  it('resets the database when the reset is asked for explicitly', async () => {
    const stale = await prisma.org.create({ data: { name: 'Stale', slug: `stale-${Date.now()}` } })

    runSeed('--force')

    expect(await prisma.org.findUnique({ where: { id: stale.id } })).toBeNull()
    expect(await prisma.org.count()).toBe(1)
  })
})
