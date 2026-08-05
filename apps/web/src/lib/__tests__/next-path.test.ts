import { describe, expect, it } from 'vitest'

import { safeNextPath } from '../next-path'

describe('safeNextPath', () => {
  it('keeps a plain path on this origin', () => {
    expect(safeNextPath('/invite/fmk_abc')).toBe('/invite/fmk_abc')
    expect(safeNextPath('/projects/1/runs?limit=10')).toBe('/projects/1/runs?limit=10')
  })

  it('refuses a protocol-relative URL', () => {
    // Browsers read `//evil.example` as a URL on another origin, so this would be an open
    // redirect that arrives wearing our domain.
    expect(safeNextPath('//evil.example')).toBe('/')
    expect(safeNextPath('/\\evil.example')).toBe('/')
  })

  it('refuses an absolute URL', () => {
    expect(safeNextPath('https://evil.example')).toBe('/')
    expect(safeNextPath('javascript:alert(1)')).toBe('/')
  })

  it('refuses a path carrying control characters', () => {
    expect(safeNextPath('/ok\r\nLocation: https://evil.example')).toBe('/')
    expect(safeNextPath('/ok\u0000')).toBe('/')
  })

  it('falls back when there is nothing to go on', () => {
    expect(safeNextPath(null)).toBe('/')
    expect(safeNextPath(undefined)).toBe('/')
    expect(safeNextPath('')).toBe('/')
  })

  it('uses the caller fallback rather than assuming the root', () => {
    expect(safeNextPath('https://evil.example', '/projects')).toBe('/projects')
  })
})
