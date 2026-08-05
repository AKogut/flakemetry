import { randomUUID } from 'node:crypto'

import { generateToken, hashToken, PrismaClient } from '@flakemetry/db'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'

import {
  acceptInvitation,
  createInvitation,
  findInvitationByHash,
  INVITATION_TTL_MS,
  listInvitations,
  listMembers,
  revokeInvitation,
} from '../members'

const hasDb = Boolean(process.env.DATABASE_URL)
const prisma = new PrismaClient()

const seed = async () => {
  const slug = `inv-${randomUUID().slice(0, 8)}`
  const org = await prisma.org.create({ data: { name: 'Acme', slug } })
  const owner = await prisma.user.create({ data: { email: `${slug}-owner@example.com` } })
  await prisma.membership.create({ data: { orgId: org.id, userId: owner.id, role: 'owner' } })
  const invitee = await prisma.user.create({ data: { email: `${slug}-invitee@example.com` } })
  return { orgId: org.id, ownerId: owner.id, inviteeId: invitee.id }
}

const invite = async (orgId: string, invitedBy: string, role: 'admin' | 'member' = 'member') => {
  const raw = generateToken()
  const { id } = await createInvitation(prisma, {
    orgId,
    email: 'teammate@acme.com',
    role,
    invitedBy,
    tokenHash: hashToken(raw),
  })
  return { raw, id }
}

describe.skipIf(!hasDb)('invitations', () => {
  beforeEach(async () => {
    await prisma.membership.deleteMany()
    await prisma.invitation.deleteMany()
    await prisma.project.deleteMany()
    await prisma.org.deleteMany()
    await prisma.user.deleteMany()
  })

  afterAll(async () => {
    await prisma.$disconnect()
  })

  it('stores only the hash, never the link', async () => {
    const { orgId, ownerId } = await seed()
    const { raw } = await invite(orgId, ownerId)

    const rows = await prisma.invitation.findMany()
    // The link is a capability to read the whole workspace. A database dump must not hand
    // it over, for the same reason ingest tokens are hashed.
    expect(JSON.stringify(rows)).not.toContain(raw)
    expect(rows[0]?.tokenHash).toBe(hashToken(raw))
  })

  it('adds the person to the workspace with the role they were offered', async () => {
    const { orgId, ownerId, inviteeId } = await seed()
    const { raw } = await invite(orgId, ownerId, 'admin')

    const outcome = await acceptInvitation(prisma, {
      tokenHash: hashToken(raw),
      userId: inviteeId,
    })

    expect(outcome).toMatchObject({ status: 'joined', role: 'admin' })
    const members = await listMembers(prisma, orgId)
    expect(members).toHaveLength(2)
    expect(members.find((member) => member.userId === inviteeId)?.role).toBe('admin')
  })

  it('cannot be used twice', async () => {
    const { orgId, ownerId, inviteeId } = await seed()
    const { raw } = await invite(orgId, ownerId)
    const other = await prisma.user.create({ data: { email: `${randomUUID()}@example.com` } })

    const first = await acceptInvitation(prisma, { tokenHash: hashToken(raw), userId: inviteeId })
    const second = await acceptInvitation(prisma, { tokenHash: hashToken(raw), userId: other.id })

    expect(first.status).toBe('joined')
    expect(second).toMatchObject({ status: 'rejected', reason: 'accepted' })
    expect(await listMembers(prisma, orgId)).toHaveLength(2)
  })

  it('cannot be used after it is cancelled', async () => {
    const { orgId, ownerId, inviteeId } = await seed()
    const { raw, id } = await invite(orgId, ownerId)

    expect(await revokeInvitation(prisma, orgId, id)).toBe(true)
    const outcome = await acceptInvitation(prisma, { tokenHash: hashToken(raw), userId: inviteeId })

    expect(outcome).toMatchObject({ status: 'rejected', reason: 'revoked' })
    expect(await listMembers(prisma, orgId)).toHaveLength(1)
  })

  it('cannot be used after it expires', async () => {
    const { orgId, ownerId, inviteeId } = await seed()
    const { raw } = await invite(orgId, ownerId)

    const later = new Date(Date.now() + INVITATION_TTL_MS + 1000)
    const outcome = await acceptInvitation(prisma, {
      tokenHash: hashToken(raw),
      userId: inviteeId,
      now: later,
    })

    expect(outcome).toMatchObject({ status: 'rejected', reason: 'expired' })
  })

  it('rejects a link nobody issued', async () => {
    const { inviteeId } = await seed()

    const outcome = await acceptInvitation(prisma, {
      tokenHash: hashToken(generateToken()),
      userId: inviteeId,
    })

    expect(outcome).toMatchObject({ status: 'rejected', reason: 'unknown' })
  })

  it('does not add a second membership for someone already in the workspace', async () => {
    const { orgId, ownerId } = await seed()
    const { raw } = await invite(orgId, ownerId)

    const outcome = await acceptInvitation(prisma, { tokenHash: hashToken(raw), userId: ownerId })

    expect(outcome).toMatchObject({ status: 'already-a-member' })
    expect(await listMembers(prisma, orgId)).toHaveLength(1)
    // Consumed anyway: it was meant for this person, and leaving it live would let it be
    // reused by whoever else has the link.
    const invitations = await listInvitations(prisma, orgId)
    expect(invitations[0]?.state).toBe('accepted')
  })

  it('cancelling an already accepted invitation changes nothing', async () => {
    const { orgId, ownerId, inviteeId } = await seed()
    const { raw, id } = await invite(orgId, ownerId)
    await acceptInvitation(prisma, { tokenHash: hashToken(raw), userId: inviteeId })

    expect(await revokeInvitation(prisma, orgId, id)).toBe(false)
    expect(await listMembers(prisma, orgId)).toHaveLength(2)
  })

  it('cannot be cancelled from another workspace', async () => {
    const mine = await seed()
    const theirs = await seed()
    const { id } = await invite(theirs.orgId, theirs.ownerId)

    expect(await revokeInvitation(prisma, mine.orgId, id)).toBe(false)
  })

  it('shows what the invitee is being offered before they accept', async () => {
    const { orgId, ownerId } = await seed()
    const { raw } = await invite(orgId, ownerId, 'admin')

    const found = await findInvitationByHash(prisma, hashToken(raw))

    expect(found).toMatchObject({ orgName: 'Acme', role: 'admin', state: 'pending' })
  })
})
