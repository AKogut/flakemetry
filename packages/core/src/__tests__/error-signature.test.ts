import { describe, expect, it } from 'vitest'

import { computeErrorSignature } from '../error-signature'

describe('computeErrorSignature', () => {
  it('collapses volatile numbers, quotes, addresses and uuids into a stable template', () => {
    const a = computeErrorSignature('Timeout 30000ms exceeded waiting for "#login"')
    const b = computeErrorSignature('Timeout 45000ms exceeded waiting for "#submit"')
    expect(a.template).toBe(b.template)
    expect(a.normalizedHash).toBe(b.normalizedHash)
    expect(a.template).toContain('N')
    expect(a.template).toContain('<str>')
  })

  it('distinguishes structurally different errors', () => {
    const a = computeErrorSignature('Timeout 30000ms exceeded')
    const b = computeErrorSignature('Element not found')
    expect(a.normalizedHash).not.toBe(b.normalizedHash)
  })

  it('folds the stack into the signature', () => {
    const withStack = computeErrorSignature('boom', 'Error: boom\n  at fn (a.ts:41)')
    expect(withStack.stackTemplate).toContain('at fn')
    expect(withStack.normalizedHash).not.toBe(computeErrorSignature('boom').normalizedHash)
  })

  it('is deterministic', () => {
    expect(computeErrorSignature('same 1 error').normalizedHash).toBe(
      computeErrorSignature('same 2 error').normalizedHash,
    )
  })
})
