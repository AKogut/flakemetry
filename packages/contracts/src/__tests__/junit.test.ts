import { describe, expect, it } from 'vitest'

import { parseJunitXml } from '../junit'

const PYTEST = `<?xml version="1.0" encoding="utf-8"?>
<testsuites>
  <testsuite name="pytest" timestamp="2026-07-16T10:00:00" tests="4" failures="1" errors="1" skipped="1" time="0.5">
    <testcase classname="tests.test_login" name="test_logs_in" file="tests/test_login.py" time="0.012" />
    <testcase classname="tests.test_login" name="test_rejects_bad_password" file="tests/test_login.py" time="0.03">
      <failure message="assert 500 == 200" type="AssertionError">tests/test_login.py:12: AssertionError</failure>
    </testcase>
    <testcase classname="tests.test_login" name="test_explodes" file="tests/test_login.py" time="0.01">
      <error message="boom" type="RuntimeError">Traceback ...</error>
    </testcase>
    <testcase classname="tests.test_login" name="test_wip" file="tests/test_login.py">
      <skipped />
    </testcase>
  </testsuite>
</testsuites>`

describe('parseJunitXml', () => {
  it('maps pytest cases with file, classname, status and duration', () => {
    const run = parseJunitXml(PYTEST)
    expect(run.startedAt).toBe('2026-07-16T10:00:00')
    expect(run.executions).toHaveLength(4)

    const byTitle = new Map(run.executions.map((execution) => [execution.title, execution]))
    const pass = byTitle.get('test_logs_in')
    expect(pass?.status).toBe('pass')
    expect(pass?.filePath).toBe('tests/test_login.py')
    expect(pass?.suite).toBe('tests.test_login')
    expect(pass?.durationMs).toBe(12)

    expect(byTitle.get('test_rejects_bad_password')?.status).toBe('fail')
    expect(byTitle.get('test_rejects_bad_password')?.error?.message).toBe('assert 500 == 200')
    expect(byTitle.get('test_explodes')?.status).toBe('fail')
    expect(byTitle.get('test_explodes')?.error?.type).toBe('RuntimeError')
    expect(byTitle.get('test_wip')?.status).toBe('skip')
  })

  it('handles a single root testsuite and derives a path from classname when file is absent', () => {
    const xml = `<testsuite name="suite" tests="1">
      <testcase classname="com.acme.LoginTest" name="logsIn" time="1" />
    </testsuite>`
    const run = parseJunitXml(xml)
    expect(run.executions).toHaveLength(1)
    expect(run.executions[0]?.filePath).toBe('com/acme/LoginTest')
    expect(run.executions[0]?.suite).toBe('com.acme.LoginTest')
    expect(run.executions[0]?.durationMs).toBe(1000)
  })

  it('returns an empty run for a report with no testcases', () => {
    expect(parseJunitXml('<testsuites></testsuites>').executions).toEqual([])
  })
})
