export interface SsoProvider {
  id: 'oidc'
  name: string
  type: 'oidc'
  issuer: string
  clientId: string
  clientSecret: string
}

export const resolveSsoProvider = (env: Record<string, string | undefined>): SsoProvider | null => {
  const issuer = env.AUTH_OIDC_ISSUER?.trim()
  const clientId = env.AUTH_OIDC_ID?.trim()
  const clientSecret = env.AUTH_OIDC_SECRET?.trim()
  if (!issuer || !clientId || !clientSecret) return null
  if (!/^https:\/\//.test(issuer) && !/^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?\//.test(issuer)) {
    return null
  }
  return {
    id: 'oidc',
    name: env.AUTH_OIDC_NAME?.trim() || 'SSO',
    type: 'oidc',
    issuer,
    clientId,
    clientSecret,
  }
}
