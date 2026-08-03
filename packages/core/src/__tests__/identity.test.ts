import { describe, expect, it } from 'vitest'

import { collectPresentTitleKeys, type ExistingIdentity, resolveIdentity } from '../identity'

const existing: ExistingIdentity = {
  id: 'id-1',
  fingerprint: 'sha256:aaa',
  suite: 'auth',
  title: 'logs in',
  paramsHash: null,
  aliases: [],
}

describe('resolveIdentity', () => {
  it('matches an exact fingerprint at L1', () => {
    const result = resolveIdentity(
      { fingerprint: 'sha256:aaa', suite: 'auth', title: 'logs in', paramsHash: null },
      [existing],
    )
    expect(result).toEqual({ kind: 'exact', identityId: 'id-1', level: 'L1' })
  })

  it('matches a moved file at L2 and stitches the new fingerprint as an alias', () => {
    const result = resolveIdentity(
      { fingerprint: 'sha256:bbb', suite: 'auth', title: 'logs in', paramsHash: null },
      [existing],
    )
    expect(result).toEqual({
      kind: 'moved',
      identityId: 'id-1',
      level: 'L2',
      addAlias: 'sha256:bbb',
    })
  })

  it('resolves a previously stitched fingerprint via aliases at L1', () => {
    const withAlias: ExistingIdentity = { ...existing, aliases: ['sha256:bbb'] }
    const result = resolveIdentity(
      { fingerprint: 'sha256:bbb', suite: 'auth', title: 'logs in', paramsHash: null },
      [withAlias],
    )
    expect(result.kind).toBe('exact')
  })

  it('creates a new identity when the title genuinely changes', () => {
    const result = resolveIdentity(
      { fingerprint: 'sha256:ccc', suite: 'auth', title: 'signs in', paramsHash: null },
      [existing],
    )
    expect(result).toEqual({ kind: 'new' })
  })

  it('keeps parameterized cases distinct via params hash', () => {
    const paramA = { ...existing, id: 'id-a', fingerprint: 'sha256:pa', paramsHash: 'h-admin' }
    const result = resolveIdentity(
      { fingerprint: 'sha256:pb', suite: 'auth', title: 'logs in', paramsHash: 'h-guest' },
      [paramA],
    )
    expect(result.kind).toBe('new')
  })

  it('is stable under a file move: same identity survives, distinct under content change', () => {
    const moved = resolveIdentity(
      { fingerprint: 'sha256:moved', suite: 'auth', title: 'logs in', paramsHash: null },
      [existing],
    )
    const changed = resolveIdentity(
      { fingerprint: 'sha256:changed', suite: 'auth', title: 'logs out', paramsHash: null },
      [existing],
    )
    expect(moved.kind).toBe('moved')
    expect(changed.kind).toBe('new')
  })
})

const inFile: ExistingIdentity = {
  id: 'id-1',
  fingerprint: 'sha256:aaa',
  suite: 'auth',
  title: 'logs in',
  paramsHash: null,
  aliases: [],
  filePath: 'e2e/auth.spec.ts',
}

describe('resolveIdentity L3 rename', () => {
  it('stitches a close, unambiguous rename in the same file and stays confident', () => {
    const result = resolveIdentity(
      {
        fingerprint: 'sha256:new',
        suite: 'auth',
        title: 'logs in successfully',
        paramsHash: null,
        filePath: 'e2e/auth.spec.ts',
      },
      [inFile],
    )
    expect(result.kind).toBe('renamed')
    if (result.kind === 'renamed') {
      expect(result.identityId).toBe('id-1')
      expect(result.addAlias).toBe('sha256:new')
      expect(result.level).toBe('L3')
      expect(result.confidence).toBeGreaterThanOrEqual(0.5)
    }
  })

  it('does not rename when the title change is too large', () => {
    const result = resolveIdentity(
      {
        fingerprint: 'sha256:new',
        suite: 'auth',
        title: 'renders the dashboard',
        paramsHash: null,
        filePath: 'e2e/auth.spec.ts',
      },
      [inFile],
    )
    expect(result.kind).toBe('new')
  })

  it('does not rename across different files', () => {
    const result = resolveIdentity(
      {
        fingerprint: 'sha256:new',
        suite: 'auth',
        title: 'logs in successfully',
        paramsHash: null,
        filePath: 'e2e/other.spec.ts',
      },
      [inFile],
    )
    expect(result.kind).toBe('new')
  })

  it('refuses an ambiguous rename when two candidates match', () => {
    const a: ExistingIdentity = {
      ...inFile,
      id: 'id-a',
      fingerprint: 'sha256:a',
      title: 'logs in ok',
    }
    const b: ExistingIdentity = {
      ...inFile,
      id: 'id-b',
      fingerprint: 'sha256:b',
      title: 'logs in now',
    }
    const result = resolveIdentity(
      {
        fingerprint: 'sha256:new',
        suite: 'auth',
        title: 'logs in',
        paramsHash: null,
        filePath: 'e2e/auth.spec.ts',
      },
      [a, b],
    )
    expect(result.kind).toBe('new')
  })

  it('does not attempt a rename when file path is unknown', () => {
    const result = resolveIdentity(
      { fingerprint: 'sha256:new', suite: 'auth', title: 'logs in successfully', paramsHash: null },
      [inFile],
    )
    expect(result.kind).toBe('new')
  })
})

describe('resolveIdentity neighbor context', () => {
  const bucket = {
    suite: 'auth',
    paramsHash: null,
    filePath: 'e2e/auth.spec.ts',
    aliases: [] as string[],
  }
  const candidate = {
    fingerprint: 'sha256:new',
    suite: 'auth',
    title: 'logs in',
    paramsHash: null,
    filePath: 'e2e/auth.spec.ts',
  }

  it('refuses to rename onto a test that is still running in the same batch', () => {
    const alive: ExistingIdentity = {
      ...bucket,
      id: 'id-alive',
      fingerprint: 'a',
      title: 'logs in ok',
    }
    const present = collectPresentTitleKeys([
      { ...bucket, title: 'logs in ok' },
      { ...bucket, title: 'logs in' },
    ])

    expect(resolveIdentity(candidate, [alive]).kind).toBe('renamed')
    expect(resolveIdentity(candidate, [alive], { presentTitleKeys: present }).kind).toBe('new')
  })

  it('uses the batch to disambiguate: the test that disappeared is the renamed one', () => {
    const gone: ExistingIdentity = {
      ...bucket,
      id: 'id-gone',
      fingerprint: 'a',
      title: 'logs in ok',
    }
    const alive: ExistingIdentity = {
      ...bucket,
      id: 'id-alive',
      fingerprint: 'b',
      title: 'logs in now',
    }
    const present = collectPresentTitleKeys([
      { ...bucket, title: 'logs in now' },
      { ...bucket, title: 'logs in' },
    ])

    expect(resolveIdentity(candidate, [gone, alive]).kind).toBe('new')

    const resolved = resolveIdentity(candidate, [gone, alive], { presentTitleKeys: present })
    expect(resolved.kind).toBe('renamed')
    if (resolved.kind === 'renamed') expect(resolved.identityId).toBe('id-gone')
  })

  it('picks a clearly better candidate but still refuses a close call', () => {
    const near: ExistingIdentity = {
      ...bucket,
      id: 'id-near',
      fingerprint: 'a',
      title: 'logs in with a valid password',
    }
    const far: ExistingIdentity = { ...bucket, id: 'id-far', fingerprint: 'b', title: 'logs in ok' }

    const clear = resolveIdentity({ ...candidate, title: 'logs in with a valid password today' }, [
      near,
      far,
    ])
    expect(clear.kind).toBe('renamed')
    if (clear.kind === 'renamed') expect(clear.identityId).toBe('id-near')

    const tie: ExistingIdentity = {
      ...bucket,
      id: 'id-tie',
      fingerprint: 'c',
      title: 'logs in now',
    }
    expect(resolveIdentity(candidate, [far, tie]).kind).toBe('new')
  })
})
