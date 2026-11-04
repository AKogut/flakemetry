import { describe, expect, it } from 'vitest'

import { extractTestCaseId } from '../test-case'

describe('extractTestCaseId', () => {
  it.each([
    ['TC-AUTH-001 — Successful login', 'TC-AUTH-001'],
    ['test_TC_AUTH_001_validLogin', 'TC-AUTH-001'],
    ['TC_AUTH_001_successfulLogin', 'TC-AUTH-001'],
    ['testTC_AUTH_001_validLogin', 'TC-AUTH-001'],
    ['TC_AUTH_001ValidLogin', 'TC-AUTH-001'],
    ['TC-AUTH_001 mixed separators', 'TC-AUTH-001'],
    ['test_tc_auth_001_valid_login', 'TC-AUTH-001'],
    ['TC-auth-001', 'TC-AUTH-001'],
    ['[TC-FILTER-12] filters', 'TC-FILTER-12'],
    ['(TC_SEARCH_0005)', 'TC-SEARCH-0005'],
    ['TC-AUTH-001-retry', 'TC-AUTH-001'],
  ])('reads %s as %s', (title, expected) => {
    expect(extractTestCaseId(title)).toBe(expected)
  })

  it.each([
    'something else',
    '',
    'TC-001',
    'TC-AUTH',
    'TC-AUTH-',
    'TC AUTH 001',
    'TCAUTH001',
    'TC-AUTH-LOGIN-001',
    'TC-A1-001',
    'ATC-AUTH-001',
    '1TC-AUTH-001',
    'etc_auth_001',
    'TC-AUTH-001a',
  ])('finds nothing in %j', (title) => {
    expect(extractTestCaseId(title)).toBeNull()
  })

  it('takes the first id when a title has two', () => {
    expect(extractTestCaseId('TC-AUTH-001 then TC-AUTH-002')).toBe('TC-AUTH-001')
  })

  it('accepts another shape and normalises it the same way', () => {
    expect(extractTestCaseId('jira_123 logs in', /jira[-_]\d+/)).toBe('JIRA-123')
    expect(extractTestCaseId('TC-AUTH-001', /jira[-_]\d+/)).toBeNull()
  })

  it.each(['g', 'y'])('gives the same answer every time for a pattern with the %s flag', (flag) => {
    const pattern = new RegExp('TC-[A-Z]+-\\d+', flag)

    expect(extractTestCaseId('TC-AUTH-001', pattern)).toBe('TC-AUTH-001')
    expect(extractTestCaseId('TC-AUTH-001', pattern)).toBe('TC-AUTH-001')
    expect(pattern.lastIndex).toBe(0)
  })
})
