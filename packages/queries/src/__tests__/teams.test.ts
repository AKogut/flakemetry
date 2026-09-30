import { describe, expect, it } from 'vitest'

import { checkTeam, normalizeTeamHandle, TEAM_NAME_MAX, teamSlug } from '../teams'

describe('normalizeTeamHandle', () => {
  it.each([
    ['@acme/qa', '@acme/qa'],
    ['acme/QA', '@acme/qa'],
    ['  @Acme/Platform-Team  ', '@acme/platform-team'],
    ['@group/sub/team', '@group/sub/team'],
    ['', null],
    ['   ', null],
  ])('reads %j as %j', (raw, expected) => {
    expect(normalizeTeamHandle(raw)).toBe(expected)
  })

  it.each(['@alice', 'alice@example.com', '@acme/', '@/qa', '@acme//qa', '@acme/q a'])(
    'refuses %j, which is not a CODEOWNERS team',
    (raw) => {
      expect(normalizeTeamHandle(raw)).toBe('invalid')
    },
  )
})

describe('checkTeam', () => {
  it('accepts a named team with or without a handle', () => {
    expect(checkTeam({ actorRole: 'admin', name: 'QA', handle: '' })).toBeNull()
    expect(checkTeam({ actorRole: 'owner', name: 'QA', handle: '@acme/qa' })).toBeNull()
  })

  it.each([
    [{ actorRole: 'member', name: 'QA', handle: '' }, 'not-a-manager'],
    [{ actorRole: 'viewer', name: 'QA', handle: '' }, 'not-a-manager'],
    [{ actorRole: 'admin', name: '  ', handle: '' }, 'empty-name'],
    [{ actorRole: 'admin', name: '!!!', handle: '' }, 'empty-name'],
    [{ actorRole: 'admin', name: 'x'.repeat(TEAM_NAME_MAX + 1), handle: '' }, 'name-too-long'],
    [{ actorRole: 'admin', name: 'QA', handle: '@alice' }, 'invalid-handle'],
  ] as const)('refuses %o with %s', (input, refusal) => {
    expect(checkTeam(input)).toBe(refusal)
  })

  it('gives names that differ only in case or punctuation the same slug', () => {
    expect(teamSlug('Platform Team')).toBe(teamSlug('platform-team'))
  })
})
