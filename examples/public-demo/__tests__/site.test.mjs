import { describe, expect, it } from 'vitest'

import { pageFileFor, relativeLink, testCaseIdOf } from '../lib/site.mjs'

const BASE = '/projects/11111111-1111-4111-8111-111111111111'
const TEST = '22222222-2222-4222-8222-222222222222'
const EXECUTION = '33333333-3333-4333-8333-333333333333'
const file = (path) =>
  pageFileFor(new URL(path, 'http://x'), BASE, 'mobile', new Map([[TEST, 'abcdef']]))

describe('pageFileFor', () => {
  it('maps the read pages', () => {
    expect(file(`${BASE}/flaky`)).toBe('mobile/flaky.html')
    expect(file(`${BASE}/flaky?filter=rising`)).toBe('mobile/flaky-rising.html')
    expect(file(`${BASE}/runs?cursor=abcdefgh1234`)).toBe('mobile/runs-abcdefgh.html')
    expect(file(`${BASE}/tests/${TEST}`)).toBe('mobile/tests/abcdef.html')
    expect(file(`${BASE}/tests/${TEST}/executions/${EXECUTION}`)).toBe(
      'mobile/tests/abcdef-33333333.html',
    )
  })

  it('leaves out anything a static page cannot serve', () => {
    expect(file(`${BASE}/settings/policy`)).toBeNull()
    expect(file(`${BASE}/runs?branch=main`)).toBeNull()
    expect(file(`${BASE}/tests/${TEST}?execution=${EXECUTION}`)).toBeNull()
    expect(file(`${BASE}/flaky?owner=someone`)).toBeNull()
    expect(file('/projects')).toBeNull()
    expect(file('/sign-in')).toBeNull()
  })
})

describe('relativeLink', () => {
  it('walks up and across directories', () => {
    expect(relativeLink('mobile/tests/a.html', 'mobile/flaky.html')).toBe('../flaky.html')
    expect(relativeLink('mobile/flaky.html', 'mobile/tests/a.html')).toBe('tests/a.html')
    expect(relativeLink('mobile/tests/a.html', 'assets/style.css')).toBe('../../assets/style.css')
    expect(relativeLink('index.html', 'mobile/flaky.html')).toBe('mobile/flaky.html')
  })
})

describe('testCaseIdOf', () => {
  it('reads one id from the naming of every runner', () => {
    expect(testCaseIdOf('TC-AUTH-001 — Successful login')).toBe('TC-AUTH-001')
    expect(testCaseIdOf('test_TC_AUTH_001_validLogin')).toBe('TC-AUTH-001')
    expect(testCaseIdOf('TC_AUTH_001_successfulLogin')).toBe('TC-AUTH-001')
    expect(testCaseIdOf('something else')).toBeNull()
  })
})
