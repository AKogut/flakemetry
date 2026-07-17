import { describe, expect, it } from 'vitest'

import { generateToken, hashToken, redactToken, TOKEN_PREFIX } from '../token'

describe('token helpers', () => {
  it('generates prefixed tokens that hash deterministically', () => {
    const token = generateToken()
    expect(token.startsWith(TOKEN_PREFIX)).toBe(true)
    expect(hashToken(token)).toBe(hashToken(token))
    expect(hashToken(token)).toHaveLength(64)
  })

  it('produces distinct hashes for distinct tokens and trims input', () => {
    expect(hashToken('a')).not.toBe(hashToken('b'))
    expect(hashToken('  fmk_x  ')).toBe(hashToken('fmk_x'))
  })

  it('redacts tokens for display', () => {
    expect(redactToken('fmk_1234567890abcdef')).toBe('fmk_1234…cdef')
    expect(redactToken('short')).toBe('********')
  })
})
