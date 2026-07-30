import { type Prisma, PrismaClient } from '@flakemetry/db'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'

import { flakyBoard } from '../flaky'

const hasDb = Boolean(process.env.DATABASE_URL)
const prisma = new PrismaClient()

const CODEOWNERS = `
*.spec.ts        @org/qa
/checkout/       @org/payments
`

const seedScore = async (
  tenant: { orgId: string; projectId: string },
  fingerprint: string,
  filePath: string,
  score: number,
): Promise<void> => {
  const identity = await prisma.testIdentity.create({
    data: { ...tenant, fingerprint, filePath, suite: 's', title: fingerprint },
  })
  await prisma.flakyScore.create({
    data: {
      ...tenant,
      testIdentityId: identity.id,
      score,
      flipRate: 0.3,
      passOnRerunRate: 0.2,
      sameShaVariance: 0.1,
      entropy: 0.4,
      failIsolation: 0.5,
      modelVersion: 'test',
      reasonCodes: [] as Prisma.InputJsonValue,
    },
  })
}

describe.skipIf(!hasDb)('flakyBoard ownership', () => {
  beforeEach(async () => {
    await prisma.flakyScore.deleteMany()
    await prisma.testIdentity.deleteMany()
    await prisma.project.deleteMany()
    await prisma.org.deleteMany()
  })

  afterAll(async () => {
    await prisma.$disconnect()
  })

  const seedProject = async () => {
    const org = await prisma.org.create({ data: { name: 'Acme', slug: `acme-${Date.now()}` } })
    const project = await prisma.project.create({
      data: { orgId: org.id, name: 'Web', slug: 'web', codeowners: CODEOWNERS },
    })
    const tenant = { orgId: org.id, projectId: project.id }
    await seedScore(tenant, 'fp-a', 'e2e/login.spec.ts', 0.9)
    await seedScore(tenant, 'fp-b', 'checkout/pay.ts', 0.8)
    await seedScore(tenant, 'fp-c', 'src/util.ts', 0.7)
    return project.id
  }

  it('resolves the CODEOWNERS owner for each flaky test', async () => {
    const projectId = await seedProject()
    const board = await flakyBoard(prisma, projectId, {
      limit: 20,
      minScore: 0,
      includeQuarantined: true,
    })

    const byFile = new Map(board.items.map((item) => [item.filePath, item.owners]))
    expect(byFile.get('e2e/login.spec.ts')).toEqual(['@org/qa'])
    expect(byFile.get('checkout/pay.ts')).toEqual(['@org/payments'])
    expect(byFile.get('src/util.ts')).toEqual([])
  })

  it('filters the board to a single owner', async () => {
    const projectId = await seedProject()
    const board = await flakyBoard(prisma, projectId, {
      limit: 20,
      minScore: 0,
      includeQuarantined: true,
      owner: '@org/qa',
    })

    expect(board.items).toHaveLength(1)
    expect(board.items[0]?.filePath).toBe('e2e/login.spec.ts')
  })
})
