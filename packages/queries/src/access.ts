export type AccessRole = 'owner' | 'admin' | 'member' | 'viewer'

export const ACCESS_ROLES: readonly AccessRole[] = ['owner', 'admin', 'member', 'viewer']

export const GRANT_ROLES: readonly AccessRole[] = ['member', 'viewer']

export const isAccessRole = (value: string): value is AccessRole =>
  (ACCESS_ROLES as readonly string[]).includes(value)

export const canManage = (role: string): boolean => role === 'owner' || role === 'admin'

export const canContribute = (role: string): boolean => canManage(role) || role === 'member'

export const effectiveProjectRole = (input: {
  orgRole: string
  restricted: boolean
  grantRole?: string | null
}): AccessRole | null => {
  if (!isAccessRole(input.orgRole)) return null
  if (canManage(input.orgRole)) return input.orgRole
  if (!input.restricted) return input.orgRole
  if (input.grantRole === 'member' || input.grantRole === 'viewer') return input.grantRole
  return null
}

export type GrantRefusal = 'not-a-manager' | 'unknown-role' | 'not-a-member' | 'already-has-access'

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
