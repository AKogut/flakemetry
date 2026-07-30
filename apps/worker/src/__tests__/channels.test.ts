import { PrismaClient } from '@flakemetry/db'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'

import { createProjectChannelLoader, mapChannelRows } from '../channels'

describe('mapChannelRows', () => {
  it('maps enabled slack/discord rows to notify channels and defaults empty events to all', () => {
    const channels = mapChannelRows([
      { id: '1', kind: 'slack', target: 'https://slack.test', events: ['flaky_detected'] },
      { id: '2', kind: 'discord', target: 'https://discord.test', events: [] },
    ])
    expect(channels).toHaveLength(2)
    expect(channels[0]).toMatchObject({ id: 'db:1', kind: 'slack', types: ['flaky_detected'] })
    expect(channels[1]?.types.length).toBeGreaterThan(1)
  })

  it('drops unknown kinds and empty targets', () => {
    expect(
      mapChannelRows([
        { id: '1', kind: 'email', target: 'x@y.z', events: [] },
        { id: '2', kind: 'slack', target: '', events: [] },
      ]),
    ).toHaveLength(0)
  })
})

const hasDb = Boolean(process.env.DATABASE_URL)
const prisma = new PrismaClient()

describe.skipIf(!hasDb)('createProjectChannelLoader', () => {
  beforeEach(async () => {
    await prisma.notificationChannel.deleteMany()
    await prisma.project.deleteMany()
    await prisma.org.deleteMany()
  })

  afterAll(async () => {
    await prisma.$disconnect()
  })

  it('loads only enabled channels for the project', async () => {
    const org = await prisma.org.create({ data: { name: 'Acme', slug: `acme-${Date.now()}` } })
    const project = await prisma.project.create({
      data: { orgId: org.id, name: 'Web', slug: 'web' },
    })
    const tenant = { orgId: org.id, projectId: project.id }
    await prisma.notificationChannel.create({
      data: { ...tenant, kind: 'slack', target: 'https://slack.test', events: ['flaky_detected'] },
    })
    await prisma.notificationChannel.create({
      data: {
        ...tenant,
        kind: 'discord',
        target: 'https://discord.test',
        events: [],
        enabled: false,
      },
    })

    const load = createProjectChannelLoader(prisma)
    const channels = await load(project.id)
    expect(channels).toHaveLength(1)
    expect(channels[0]?.kind).toBe('slack')
  })
})
