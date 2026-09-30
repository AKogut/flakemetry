import { describe, expect, it } from 'vitest'

import { canContribute, canManage, checkGrant, effectiveProjectRole } from '../access'
import { checkInvite, checkRemoval, checkRoleChange } from '../members'

describe('effectiveProjectRole', () => {
  it.each([
    ['owner', false, null, 'owner'],
    ['admin', true, null, 'admin'],
    ['member', false, null, 'member'],
    ['viewer', false, null, 'viewer'],
    ['member', true, null, null],
    ['viewer', true, null, null],
    ['member', true, 'viewer', 'viewer'],
    ['viewer', true, 'member', 'member'],
    ['stranger', false, null, null],
  ] as const)(
    'an org %s on a project restricted=%s with grant %s acts as %s',
    (orgRole, restricted, grantRole, expected) => {
      expect(effectiveProjectRole({ orgRole, restricted, grantRole })).toBe(expected)
    },
  )
})

describe('what each role may do', () => {
  it('lets owners and admins manage, members contribute, and viewers only read', () => {
    expect(['owner', 'admin', 'member', 'viewer'].map(canManage)).toEqual([
      true,
      true,
      false,
      false,
    ])
    expect(['owner', 'admin', 'member', 'viewer'].map(canContribute)).toEqual([
      true,
      true,
      true,
      false,
    ])
  })
})

describe('checkGrant', () => {
  it('lets a manager grant member or viewer access to a member of the workspace', () => {
    expect(
      checkGrant({ actorRole: 'admin', targetOrgRole: 'viewer', grantRole: 'member' }),
    ).toBeNull()
  })

  it.each([
    [{ actorRole: 'member', targetOrgRole: 'viewer', grantRole: 'viewer' }, 'not-a-manager'],
    [{ actorRole: 'owner', targetOrgRole: 'member', grantRole: 'admin' }, 'unknown-role'],
    [{ actorRole: 'owner', targetOrgRole: null, grantRole: 'viewer' }, 'not-a-member'],
    [{ actorRole: 'owner', targetOrgRole: 'admin', grantRole: 'viewer' }, 'already-has-access'],
  ] as const)('refuses %o with %s', (input, refusal) => {
    expect(checkGrant(input)).toBe(refusal)
  })
})

describe('the viewer role in membership changes', () => {
  it('lets an admin invite and remove a viewer, but not promote anyone to admin', () => {
    expect(checkInvite({ actorRole: 'admin', invitedRole: 'viewer' })).toBeNull()
    expect(checkRemoval({ actorRole: 'admin', targetRole: 'viewer', ownerCount: 1 })).toBeNull()
    expect(checkInvite({ actorRole: 'admin', invitedRole: 'admin' })).toBe('owner-only')
    expect(
      checkRoleChange({
        actorRole: 'owner',
        targetRole: 'member',
        newRole: 'viewer',
        ownerCount: 1,
      }),
    ).toBeNull()
  })
})
