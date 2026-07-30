import { describe, expect, it } from 'vitest'

import { matchCodeowners, parseCodeowners } from '../codeowners'

const CODEOWNERS = `
# comment line
*                       @org/default
*.spec.ts               @org/qa
/e2e/                   @org/e2e-team
apps/web/**             @web-lead
docs/*                  @org/writers
`

describe('parseCodeowners', () => {
  it('skips comments and blank lines and keeps owners', () => {
    const rules = parseCodeowners(CODEOWNERS)
    expect(rules).toHaveLength(5)
    expect(rules[0]?.owners).toEqual(['@org/default'])
  })
})

describe('matchCodeowners', () => {
  const rules = parseCodeowners(CODEOWNERS)

  it('applies the last matching rule (CODEOWNERS precedence)', () => {
    expect(matchCodeowners(rules, 'src/util.ts')).toEqual(['@org/default'])
    expect(matchCodeowners(rules, 'login.spec.ts')).toEqual(['@org/qa'])
  })

  it('matches a filename glob at any directory depth', () => {
    expect(matchCodeowners(rules, 'src/auth/login.spec.ts')).toEqual(['@org/qa'])
  })

  it('lets a later rule override an earlier one for the same path', () => {
    expect(matchCodeowners(rules, 'e2e/auth/login.spec.ts')).toEqual(['@org/e2e-team'])
  })

  it('matches an anchored directory and everything under it', () => {
    expect(matchCodeowners(rules, 'e2e/checkout.ts')).toEqual(['@org/e2e-team'])
    expect(matchCodeowners(rules, 'src/e2e/checkout.ts')).toEqual(['@org/default'])
  })

  it('honours ** across segments but * within one segment', () => {
    expect(matchCodeowners(rules, 'apps/web/src/components/a.tsx')).toEqual(['@web-lead'])
    expect(matchCodeowners(rules, 'docs/guide.md')).toEqual(['@org/writers'])
    expect(matchCodeowners(rules, 'docs/sub/guide.md')).toEqual(['@org/default'])
  })

  it('returns no owners when nothing matches', () => {
    expect(matchCodeowners([], 'anything.ts')).toEqual([])
  })
})
