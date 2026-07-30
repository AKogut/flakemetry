import { generateToken, hashToken, PrismaClient } from '@flakemetry/db'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'

import { buildApp } from '../app'

const hasDb = Boolean(process.env.DATABASE_URL)
const prisma = new PrismaClient()

const seedToken = async () => {
  const org = await prisma.org.create({ data: { name: 'Acme', slug: `acme-${Date.now()}` } })
  const project = await prisma.project.create({ data: { orgId: org.id, name: 'Web', slug: 'web' } })
  const raw = generateToken()
  await prisma.ingestToken.create({
    data: { orgId: org.id, projectId: project.id, name: 'ci', tokenHash: hashToken(raw) },
  })
  return { raw, projectId: project.id }
}

describe.skipIf(!hasDb)('PUT /v1/codeowners', () => {
  beforeEach(async () => {
    await prisma.ingestToken.deleteMany()
    await prisma.project.deleteMany()
    await prisma.org.deleteMany()
  })

  afterAll(async () => {
    await prisma.$disconnect()
  })

  it('stores the CODEOWNERS content on the token project', async () => {
    const { raw, projectId } = await seedToken()
    const app = buildApp({ prisma })

    const res = await app.inject({
      method: 'PUT',
      url: '/v1/codeowners',
      headers: { authorization: `Bearer ${raw}` },
      payload: { content: '*.spec.ts @org/qa\n' },
    })

    expect(res.statusCode).toBe(200)
    const project = await prisma.project.findUniqueOrThrow({ where: { id: projectId } })
    expect(project.codeowners).toBe('*.spec.ts @org/qa')
    await app.close()
  })

  it('clears the CODEOWNERS when given blank content', async () => {
    const { raw, projectId } = await seedToken()
    await prisma.project.update({ where: { id: projectId }, data: { codeowners: '* @team' } })
    const app = buildApp({ prisma })

    const res = await app.inject({
      method: 'PUT',
      url: '/v1/codeowners',
      headers: { authorization: `Bearer ${raw}` },
      payload: { content: '   ' },
    })

    expect(res.statusCode).toBe(200)
    const project = await prisma.project.findUniqueOrThrow({ where: { id: projectId } })
    expect(project.codeowners).toBeNull()
    await app.close()
  })

  it('rejects an unauthenticated request', async () => {
    const app = buildApp({ prisma })
    const res = await app.inject({
      method: 'PUT',
      url: '/v1/codeowners',
      payload: { content: '* @team' },
    })
    expect(res.statusCode).toBe(401)
    await app.close()
  })
})
