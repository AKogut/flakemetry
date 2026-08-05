import { describe, expect, it } from 'vitest'

import { checkErasureRequest } from '../erasure-guard'

const request = (over: Partial<Parameters<typeof checkErasureRequest>[0]> = {}) =>
  checkErasureRequest({ role: 'owner', typed: 'web', expected: 'web', ...over })

describe('checkErasureRequest', () => {
  it('lets the owner through when the confirmation matches', () => {
    expect(request()).toBeNull()
  })

  it('refuses an admin', () => {
    // Every other setting on these pages is admin-editable. This one is not, because it is
    // the only one with no undo.
    expect(request({ role: 'admin' })).toBe('not-owner')
    expect(request({ role: 'member' })).toBe('not-owner')
  })

  it('refuses a confirmation that does not match', () => {
    expect(request({ typed: 'wed' })).toBe('confirmation-mismatch')
    expect(request({ typed: 'WEB' })).toBe('confirmation-mismatch')
  })

  it('forgives surrounding whitespace from a paste', () => {
    expect(request({ typed: '  web ' })).toBeNull()
  })

  it('refuses an empty box even when there is nothing to match', () => {
    // Otherwise a project whose slug went missing would be deletable by submitting the
    // form untouched.
    expect(request({ typed: '', expected: '' })).toBe('confirmation-mismatch')
    expect(request({ typed: '   ', expected: 'web' })).toBe('confirmation-mismatch')
  })

  it('checks the role before the confirmation', () => {
    // A non-owner who guesses the slug still learns nothing they did not already know,
    // but the refusal they get should be the accurate one.
    expect(request({ role: 'member', typed: 'nope' })).toBe('not-owner')
  })
})
