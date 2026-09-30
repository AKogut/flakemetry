export type AccessRole = 'owner' | 'admin' | 'member' | 'viewer'

export const ACCESS_ROLES: readonly AccessRole[] = ['owner', 'admin', 'member', 'viewer']

export const GRANT_ROLES: readonly AccessRole[] = ['member', 'viewer']

export const isAccessRole = (value: string): value is AccessRole =>
  (ACCESS_ROLES as readonly string[]).includes(value)

export const canManage = (role: string): boolean => role === 'owner' || role === 'admin'

export const canContribute = (role: string): boolean => canManage(role) || role === 'member'

export const strongestGrant = (roles: readonly string[]): 'member' | 'viewer' | null => {
  if (roles.includes('member')) return 'member'
  if (roles.includes('viewer')) return 'viewer'
  return null
}

export const effectiveProjectRole = (input: {
  orgRole: string
  restricted: boolean
  grantRoles?: readonly string[]
}): AccessRole | null => {
  if (!isAccessRole(input.orgRole)) return null
  if (canManage(input.orgRole)) return input.orgRole
  if (!input.restricted) return input.orgRole
  return strongestGrant(input.grantRoles ?? [])
}

export type GrantRefusal =
  'not-a-manager' | 'unknown-role' | 'not-a-member' | 'already-has-access' | 'unknown-team'

export const checkGrant = (input: {
  actorRole: string
  targetOrgRole: string | null
  grantRole: string
}): GrantRefusal | null => {
  if (!canManage(input.actorRole)) return 'not-a-manager'
  if (!(GRANT_ROLES as readonly string[]).includes(input.grantRole)) return 'unknown-role'
  if (input.targetOrgRole === null) return 'not-a-member'
  if (canManage(input.targetOrgRole)) return 'already-has-access'
  return null
}

export const checkTeamGrant = (input: {
  actorRole: string
  teamExists: boolean
  grantRole: string
}): GrantRefusal | null => {
  if (!canManage(input.actorRole)) return 'not-a-manager'
  if (!(GRANT_ROLES as readonly string[]).includes(input.grantRole)) return 'unknown-role'
  if (!input.teamExists) return 'unknown-team'
  return null
}
