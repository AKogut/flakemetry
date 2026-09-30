import { describe, expect, it } from 'vitest'

import { resolveSsoProvider } from '../sso'

const complete = {
  AUTH_OIDC_ISSUER: 'https://login.example.com/realms/acme',
  AUTH_OIDC_ID: 'flakemetry',
  AUTH_OIDC_SECRET: 's3cret',
}

describe('resolveSsoProvider', () => {
  it('is off unless issuer, client id and secret are all set', () => {
    expect(resolveSsoProvider({})).toBeNull()
    expect(resolveSsoProvider({ ...complete, AUTH_OIDC_SECRET: '' })).toBeNull()
  })

  it('builds an OIDC provider named after AUTH_OIDC_NAME', () => {
    expect(resolveSsoProvider({ ...complete, AUTH_OIDC_NAME: 'Okta' })).toMatchObject({
      id: 'oidc',
      type: 'oidc',
      name: 'Okta',
      issuer: complete.AUTH_OIDC_ISSUER,
    })
    expect(resolveSsoProvider(complete)?.name).toBe('SSO')
  })

  it('refuses a plain-http issuer anywhere but localhost', () => {
    expect(
      resolveSsoProvider({ ...complete, AUTH_OIDC_ISSUER: 'http://idp.example.com/' }),
    ).toBeNull()
    expect(
      resolveSsoProvider({ ...complete, AUTH_OIDC_ISSUER: 'http://localhost:8080/realms/dev' }),
    ).not.toBeNull()
  })
})
