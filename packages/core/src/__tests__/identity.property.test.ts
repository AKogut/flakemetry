import fc from 'fast-check'
import { describe, expect, it } from 'vitest'

import { computeFingerprint, hashParams, normalizeFilePath } from '../fingerprint'
import { type ExistingIdentity, resolveIdentity } from '../identity'

const nonEmpty = fc.string({ minLength: 1, maxLength: 40 }).filter((s) => s.trim().length > 0)
const filePath = fc
  .array(nonEmpty, { minLength: 1, maxLength: 4 })
  .map((segments) => `${segments.join('/')}.spec.ts`)

const asExisting = (
  candidate: { fingerprint: string; suite: string; title: string; paramsHash: string | null },
  id = 'identity-1',
): ExistingIdentity => ({ ...candidate, id, aliases: [] })

const candidateFor = (path: string, suite: string, title: string, paramsHash: string | null) => ({
  fingerprint: computeFingerprint({ filePath: path, suite, title, paramsHash }),
  suite,
  title,
  paramsHash,
})

describe('identity properties', () => {
  it('resolves a moved file to the same identity for any path change', () => {
    fc.assert(
      fc.property(filePath, filePath, nonEmpty, nonEmpty, (from, to, suite, title) => {
        fc.pre(normalizeFilePath(from) !== normalizeFilePath(to))

        const original = candidateFor(from, suite, title, null)
        const afterMove = candidateFor(to, suite, title, null)
        const resolution = resolveIdentity(afterMove, [asExisting(original)])

        expect(resolution.kind).toBe('moved')
        if (resolution.kind === 'moved') expect(resolution.identityId).toBe('identity-1')
      }),
    )
  })

  it('treats a different title as a different identity even at the same path', () => {
    fc.assert(
      fc.property(filePath, nonEmpty, nonEmpty, nonEmpty, (path, suite, titleA, titleB) => {
        fc.pre(titleA.trim() !== titleB.trim())

        const original = candidateFor(path, suite, titleA, null)
        const renamed = candidateFor(path, suite, titleB, null)

        expect(renamed.fingerprint).not.toBe(original.fingerprint)
        expect(resolveIdentity(renamed, [asExisting(original)]).kind).toBe('new')
      }),
    )
  })

  it('resolves exactly when nothing changed', () => {
    fc.assert(
      fc.property(filePath, nonEmpty, nonEmpty, (path, suite, title) => {
        const candidate = candidateFor(path, suite, title, null)
        expect(resolveIdentity(candidate, [asExisting(candidate)]).kind).toBe('exact')
      }),
    )
  })

  it('resolves through an alias recorded by an earlier move', () => {
    fc.assert(
      fc.property(filePath, filePath, nonEmpty, nonEmpty, (from, to, suite, title) => {
        fc.pre(normalizeFilePath(from) !== normalizeFilePath(to))

        const original = candidateFor(from, suite, title, null)
        const afterMove = candidateFor(to, suite, title, null)
        const stitched: ExistingIdentity = {
          ...asExisting(original),
          aliases: [afterMove.fingerprint],
        }

        expect(resolveIdentity(afterMove, [stitched]).kind).toBe('exact')
      }),
    )
  })

  it('normalizes paths idempotently', () => {
    fc.assert(
      fc.property(filePath, (path) => {
        const once = normalizeFilePath(path)
        expect(normalizeFilePath(once)).toBe(once)
      }),
    )
  })

  it('hashes params independently of key order', () => {
    fc.assert(
      fc.property(fc.dictionary(nonEmpty, fc.integer(), { maxKeys: 6 }), (params) => {
        const reversed = Object.fromEntries(Object.entries(params).reverse())
        expect(hashParams(params)).toBe(hashParams(reversed))
      }),
    )
  })

  it('keeps parameterized variants distinct', () => {
    fc.assert(
      fc.property(
        filePath,
        nonEmpty,
        nonEmpty,
        fc.integer(),
        fc.integer(),
        (path, suite, title, a, b) => {
          fc.pre(a !== b)

          const first = candidateFor(path, suite, title, hashParams({ case: a }))
          const second = candidateFor(path, suite, title, hashParams({ case: b }))

          expect(second.fingerprint).not.toBe(first.fingerprint)
          expect(resolveIdentity(second, [asExisting(first)]).kind).toBe('new')
        },
      ),
    )
  })
})
