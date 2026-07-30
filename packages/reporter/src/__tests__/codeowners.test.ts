import { describe, expect, it, vi } from 'vitest'

import { findCodeowners, uploadCodeowners } from '../codeowners'

describe('findCodeowners', () => {
  it('reads an explicit file from the environment first', () => {
    const readFile = vi.fn((path: string) => (path === '/custom/OWNERS' ? '* @team\n' : ''))
    const content = findCodeowners(
      '/repo/e2e',
      { FLAKEMETRY_CODEOWNERS_FILE: '/custom/OWNERS' },
      { readFile },
    )
    expect(content).toBe('* @team\n')
  })

  it('walks up from the start dir to find .github/CODEOWNERS', () => {
    const readFile = vi.fn((path: string) => {
      if (path === '/repo/.github/CODEOWNERS') return '*.spec.ts @qa\n'
      throw new Error('missing')
    })
    const content = findCodeowners('/repo/apps/web', {}, { readFile })
    expect(content).toBe('*.spec.ts @qa\n')
  })

  it('returns null when nothing is found', () => {
    const readFile = vi.fn(() => {
      throw new Error('missing')
    })
    expect(findCodeowners('/repo', {}, { readFile })).toBeNull()
  })
})

describe('uploadCodeowners', () => {
  it('PUTs the content to the codeowners endpoint with the token', async () => {
    const calls: { url: string; init: RequestInit }[] = []
    const fetchImpl = vi.fn(async (url: unknown, init: unknown) => {
      calls.push({ url: String(url), init: init as RequestInit })
      return { ok: true } as Response
    }) as unknown as typeof fetch

    const ok = await uploadCodeowners({
      endpoint: 'https://api.test/',
      token: 'tok',
      content: '* @team',
      fetchImpl,
    })

    expect(ok).toBe(true)
    expect(calls[0]?.url).toBe('https://api.test/v1/codeowners')
    expect(calls[0]?.init.method).toBe('PUT')
    expect(
      String(
        calls[0]?.init.headers && (calls[0].init.headers as Record<string, string>).authorization,
      ),
    ).toContain('tok')
    expect(String(calls[0]?.init.body)).toContain('@team')
  })
})
