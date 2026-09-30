import { randomUUID } from 'node:crypto'

import { createPrismaClient } from '@flakemetry/db'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'

import { removeMember } from '../members'
import {
  addTeamMember,
  createTeam,
  deleteTeam,
  listTeams,
  removeTeamMember,
  teamsByHandle,
  updateTeam,
} from '../teams'

const hasDb = Boolean(process.env.DATABASE_URL)
const prisma = createPrismaClient()

const seed = async () => {
  const slug = `team-${randomUUID().slice(0, 8)}`
  const org = await prisma.org.create({ data: { name: 'Acme', slug } })
  const user = await prisma.user.create({ data: { email: `${slug}@example.com`, name: 'Ada' } })
  await prisma.membership.create({ data: { orgId: org.id, userId: user.id, role: 'member' } })
  const project = await prisma.project.create({
    data: { orgId: org.id, name: 'Web', slug: 'web', restricted: true },
  })
  return { orgId: org.id, userId: user.id, projectId: project.id }
}

const created = async (orgId: string, name: string, handle = ''): Promise<string> => {
  const outcome = await createTeam(prisma, { orgId, name, handle })
  if (outcome.status !== 'saved') throw new Error(`team not created: ${outcome.reason}`)
  return outcome.id
}

describe.skipIf(!hasDb)('teams', () => {
  beforeEach(async () => {
    await prisma.projectGrant.deleteMany()
    await prisma.teamMember.deleteMany()
    await prisma.team.deleteMany()
    await prisma.membership.deleteMany()
    await prisma.project.deleteMany()
    await prisma.org.deleteMany()
    await prisma.user.deleteMany()
  })

  afterAll(async () => {
    await prisma.$disconnect()
  })

  it('creates a team with its members and CODEOWNERS handle', async () => {
    const a = await seed()
    const teamId = await created(a.orgId, 'QA', 'Acme/QA')

    expect(await addTeamMember(prisma, { orgId: a.orgId, teamId, userId: a.userId })).toBe('added')
    expect(await addTeamMember(prisma, { orgId: a.orgId, teamId, userId: a.userId })).toBe(
      'already',
    )

    expect(await listTeams(prisma, a.orgId)).toEqual([
      {
        id: teamId,
        name: 'QA',
        slug: 'qa',
        handle: '@acme/qa',
        members: [{ userId: a.userId, name: 'Ada', email: expect.any(String) }],
      },
    ])
  })

  it('refuses a second team with the same name or handle in one workspace, not across two', async () => {
    const a = await seed()
    const b = await seed()
    await created(a.orgId, 'QA', '@acme/qa')

    expect(await createTeam(prisma, { orgId: a.orgId, name: 'qa', handle: '' })).toEqual({
      status: 'rejected',
      reason: 'name-taken',
    })
    expect(
      await createTeam(prisma, { orgId: a.orgId, name: 'Testers', handle: '@ACME/qa' }),
    ).toEqual({ status: 'rejected', reason: 'handle-taken' })
    expect(await createTeam(prisma, { orgId: b.orgId, name: 'QA', handle: '@acme/qa' })).toEqual(
      expect.objectContaining({ status: 'saved' }),
    )
  })

  it('renames a team and moves its handle, but not onto another team', async () => {
    const a = await seed()
    const qa = await created(a.orgId, 'QA', '@acme/qa')
    await created(a.orgId, 'Platform', '@acme/platform')

    expect(
      await updateTeam(prisma, { orgId: a.orgId, teamId: qa, name: 'Quality', handle: '@acme/qa' }),
    ).toEqual({ status: 'saved', id: qa })
    expect(
      await updateTeam(prisma, {
        orgId: a.orgId,
        teamId: qa,
        name: 'Quality',
        handle: '@acme/platform',
      }),
    ).toEqual({ status: 'rejected', reason: 'handle-taken' })
  })

  it('never reaches a team or a person of another workspace', async () => {
    const a = await seed()
    const b = await seed()
    const theirs = await created(b.orgId, 'Theirs')
    const ours = await created(a.orgId, 'Ours')

    expect(await addTeamMember(prisma, { orgId: a.orgId, teamId: theirs, userId: a.userId })).toBe(
      'unknown-team',
    )
    expect(await addTeamMember(prisma, { orgId: a.orgId, teamId: ours, userId: b.userId })).toBe(
      'not-a-member',
    )
    expect(
      await updateTeam(prisma, { orgId: a.orgId, teamId: theirs, name: 'Mine', handle: '' }),
    ).toBeNull()
    expect(await deleteTeam(prisma, a.orgId, theirs)).toBe(false)
    expect(await prisma.team.count({ where: { id: theirs } })).toBe(1)
  })

  it('refuses at the database a team member who is not in the workspace', async () => {
    const a = await seed()
    const b = await seed()
    const teamId = await created(a.orgId, 'QA')

    await expect(
      prisma.teamMember.create({ data: { teamId, orgId: a.orgId, userId: b.userId } }),
    ).rejects.toThrow()
    await expect(
      prisma.teamMember.create({ data: { teamId, orgId: b.orgId, userId: b.userId } }),
    ).rejects.toThrow()
  })

  it('refuses at the database a grant with no target, or with two', async () => {
    const a = await seed()
    const teamId = await created(a.orgId, 'QA')
    const base = { orgId: a.orgId, projectId: a.projectId, role: 'viewer' as const }

    await expect(prisma.projectGrant.create({ data: base })).rejects.toThrow()
    await expect(
      prisma.projectGrant.create({ data: { ...base, userId: a.userId, teamId } }),
    ).rejects.toThrow()
  })

  it('drops a person from their teams when they leave the workspace', async () => {
    const a = await seed()
    const teamId = await created(a.orgId, 'QA')
    await addTeamMember(prisma, { orgId: a.orgId, teamId, userId: a.userId })

    await removeMember(prisma, a.orgId, a.userId)

    expect(await prisma.teamMember.count({ where: { teamId } })).toBe(0)
  })

  it('takes the team grants with it when a team is deleted', async () => {
    const a = await seed()
    const teamId = await created(a.orgId, 'QA')
    await prisma.projectGrant.create({
      data: { orgId: a.orgId, projectId: a.projectId, teamId, role: 'member' },
    })

    expect(await deleteTeam(prisma, a.orgId, teamId)).toBe(true)

    expect(await prisma.projectGrant.count({ where: { projectId: a.projectId } })).toBe(0)
  })

  it('removes one member without touching the rest', async () => {
    const a = await seed()
    const other = await prisma.user.create({ data: { email: `${randomUUID()}@example.com` } })
    await prisma.membership.create({ data: { orgId: a.orgId, userId: other.id, role: 'viewer' } })
    const teamId = await created(a.orgId, 'QA')
    await addTeamMember(prisma, { orgId: a.orgId, teamId, userId: a.userId })
    await addTeamMember(prisma, { orgId: a.orgId, teamId, userId: other.id })

    expect(await removeTeamMember(prisma, { orgId: a.orgId, teamId, userId: a.userId })).toBe(true)
    expect(await removeTeamMember(prisma, { orgId: a.orgId, teamId, userId: a.userId })).toBe(false)

    expect((await listTeams(prisma, a.orgId))[0]?.members.map((member) => member.userId)).toEqual([
      other.id,
    ])
  })

  it('names the CODEOWNERS owners that are Flakemetry teams, keyed as CODEOWNERS wrote them', async () => {
    const a = await seed()
    const b = await seed()
    await created(a.orgId, 'QA', '@acme/qa')
    await created(b.orgId, 'Platform', '@acme/platform')

    const named = await teamsByHandle(prisma, a.orgId, [
      '@Acme/QA',
      '@acme/platform',
      '@alice',
      'bob@example.com',
    ])

    expect([...named]).toEqual([['@Acme/QA', 'QA']])
  })
})
