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
  return { raw, orgId: org.id, projectId: project.id }
}

describe.skipIf(!hasDb)('PUT /v1/notifications/routing', () => {
  beforeEach(async () => {
    await prisma.notificationChannel.deleteMany()
    await prisma.ingestToken.deleteMany()
    await prisma.project.deleteMany()
    await prisma.org.deleteMany()
  })

  afterAll(async () => {
    await prisma.$disconnect()
  })

  it('replaces config-sourced channels and leaves dashboard channels intact', async () => {
    const { raw, orgId, projectId } = await seedToken()
    await prisma.notificationChannel.create({
      data: {
        orgId,
        projectId,
        kind: 'slack',
        target: 'https://dash',
        events: [],
        source: 'dashboard',
      },
    })
    await prisma.notificationChannel.create({
      data: {
        orgId,
        projectId,
        kind: 'discord',
        target: 'https://old',
        events: [],
        source: 'config',
      },
    })
    const app = buildApp({ prisma })

    const res = await app.inject({
      method: 'PUT',
      url: '/v1/notifications/routing',
      headers: { authorization: `Bearer ${raw}` },
      payload: {
        channels: [{ kind: 'email', target: 'alerts@acme.com', events: ['rca_ready'] }],
      },
    })

    expect(res.statusCode).toBe(200)
    const channels = await prisma.notificationChannel.findMany({ where: { projectId } })
    const bySource = channels.reduce<Record<string, number>>((acc, c) => {
      acc[c.source] = (acc[c.source] ?? 0) + 1
      return acc
    }, {})
    expect(bySource).toEqual({ dashboard: 1, config: 1 })
    const config = channels.find((c) => c.source === 'config')
    expect(config).toMatchObject({ kind: 'email', target: 'alerts@acme.com' })
    await app.close()
  })

  it('clears config channels when given an empty routing', async () => {
    const { raw, orgId, projectId } = await seedToken()
    await prisma.notificationChannel.create({
      data: {
        orgId,
        projectId,
        kind: 'slack',
        target: 'https://old',
        events: [],
        source: 'config',
      },
    })
    const app = buildApp({ prisma })

    const res = await app.inject({
      method: 'PUT',
      url: '/v1/notifications/routing',
      headers: { authorization: `Bearer ${raw}` },
      payload: { channels: [] },
    })

    expect(res.statusCode).toBe(200)
    expect(await prisma.notificationChannel.count({ where: { projectId } })).toBe(0)
    await app.close()
  })

  it('rejects an unauthenticated request', async () => {
    const app = buildApp({ prisma })
    const res = await app.inject({
      method: 'PUT',
      url: '/v1/notifications/routing',
      payload: { channels: [] },
    })
    expect(res.statusCode).toBe(401)
    await app.close()
  })
})
