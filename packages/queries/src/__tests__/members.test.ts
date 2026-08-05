import { describe, expect, it } from 'vitest'

import {
  checkInvite,
  checkRemoval,
  checkRoleChange,
  INVITATION_TTL_MS,
  invitationState,
  isMemberRole,
} from '../members'

const NOW = new Date('2026-08-05T12:00:00Z')

describe('checkInvite', () => {
  it('lets an owner invite anyone', () => {
    expect(checkInvite({ actorRole: 'owner', invitedRole: 'owner' })).toBeNull()
    expect(checkInvite({ actorRole: 'owner', invitedRole: 'admin' })).toBeNull()
    expect(checkInvite({ actorRole: 'owner', invitedRole: 'member' })).toBeNull()
  })

  it('lets an admin bring in a teammate', () => {
    expect(checkInvite({ actorRole: 'admin', invitedRole: 'member' })).toBeNull()
  })

  it('stops an admin from creating another admin or an owner', () => {
    // Otherwise an admin can grant away control of the workspace — an escalation dressed
    // up as an invitation.
    expect(checkInvite({ actorRole: 'admin', invitedRole: 'admin' })).toBe('owner-only')
    expect(checkInvite({ actorRole: 'admin', invitedRole: 'owner' })).toBe('owner-only')
  })

  it('refuses a plain member outright', () => {
    expect(checkInvite({ actorRole: 'member', invitedRole: 'member' })).toBe('not-a-manager')
  })

  it('refuses a role it does not recognise', () => {
    expect(checkInvite({ actorRole: 'owner', invitedRole: 'superuser' })).toBe('unknown-role')
  })
})

describe('checkRoleChange', () => {
  const base = { actorRole: 'owner', targetRole: 'member', newRole: 'admin', ownerCount: 2 }

  it('is an owner decision', () => {
    expect(checkRoleChange(base)).toBeNull()
    expect(checkRoleChange({ ...base, actorRole: 'admin' })).toBe('owner-only')
    expect(checkRoleChange({ ...base, actorRole: 'member' })).toBe('not-a-manager')
  })

  it('will not demote the last owner', () => {
    // A workspace with no owner has nobody who can invite, delete or hand it over, and no
    // way back short of the database.
    expect(checkRoleChange({ ...base, targetRole: 'owner', newRole: 'admin', ownerCount: 1 })).toBe(
      'last-owner',
    )
  })

  it('allows demoting an owner while another remains', () => {
    expect(
      checkRoleChange({ ...base, targetRole: 'owner', newRole: 'admin', ownerCount: 2 }),
    ).toBeNull()
  })

  it('does not treat re-saving the last owner as a demotion', () => {
    expect(
      checkRoleChange({ ...base, targetRole: 'owner', newRole: 'owner', ownerCount: 1 }),
    ).toBeNull()
  })
})

describe('checkRemoval', () => {
  it('lets an admin remove a member but not another admin', () => {
    expect(checkRemoval({ actorRole: 'admin', targetRole: 'member', ownerCount: 1 })).toBeNull()
    expect(checkRemoval({ actorRole: 'admin', targetRole: 'admin', ownerCount: 1 })).toBe(
      'owner-only',
    )
  })

  it('will not remove the last owner', () => {
    expect(checkRemoval({ actorRole: 'owner', targetRole: 'owner', ownerCount: 1 })).toBe(
      'last-owner',
    )
    expect(checkRemoval({ actorRole: 'owner', targetRole: 'owner', ownerCount: 2 })).toBeNull()
  })

  it('refuses a plain member', () => {
    expect(checkRemoval({ actorRole: 'member', targetRole: 'member', ownerCount: 2 })).toBe(
      'not-a-manager',
    )
  })
})

describe('invitationState', () => {
  const pending = {
    acceptedAt: null,
    revokedAt: null,
    expiresAt: new Date(NOW.getTime() + INVITATION_TTL_MS),
  }

  it('is pending while it is live', () => {
    expect(invitationState(pending, NOW)).toBe('pending')
  })

  it('is expired the moment it expires', () => {
    // Not a second later: an invitation that works at exactly its expiry is one whose
    // expiry is decorative.
    expect(invitationState({ ...pending, expiresAt: NOW }, NOW)).toBe('expired')
  })

  it('reports acceptance before revocation and expiry', () => {
    expect(
      invitationState({ ...pending, acceptedAt: NOW, revokedAt: NOW, expiresAt: NOW }, NOW),
    ).toBe('accepted')
  })

  it('reports a cancelled invitation as revoked, not expired', () => {
    expect(invitationState({ ...pending, revokedAt: NOW, expiresAt: NOW }, NOW)).toBe('revoked')
  })
})

describe('isMemberRole', () => {
  it('accepts the three roles and nothing else', () => {
    expect(isMemberRole('owner')).toBe(true)
    expect(isMemberRole('admin')).toBe(true)
    expect(isMemberRole('member')).toBe(true)
    expect(isMemberRole('root')).toBe(false)
  })
})
