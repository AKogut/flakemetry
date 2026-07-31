import { describe, expect, it, vi } from 'vitest'

import { runJunitUpload } from '../commands/junit'

const JUNIT = `<testsuites>
  <testsuite name="pytest" timestamp="2026-07-16T10:00:00" tests="2">
    <testcase classname="tests.test_login" name="test_logs_in" file="tests/test_login.py" time="0.01" />
    <testcase classname="tests.test_login" name="test_fails" file="tests/test_login.py" time="0.02">
      <failure message="boom" type="AssertionError">tests/test_login.py:9</failure>
    </testcase>
  </testsuite>
</testsuites>`

const okFetch = () =>
  vi.fn(async () => ({
    ok: true,
    status: 202,
    json: async () => ({ receiptId: 'receipt-1', acceptedExecutions: 2 }),
  })) as unknown as typeof fetch

const withFile = (contents: string) => ({
  readFile: () => contents,
  fileExists: () => true,
})

describe('runJunitUpload', () => {
  it('skips without endpoint or token', async () => {
    const outcome = await runJunitUpload({
      file: 'junit.xml',
      endpoint: '',
      token: 'fmk_x',
      env: {},
      ...withFile(JUNIT),
    })
    expect(outcome.status).toBe('skipped')
  })

  it('parses JUnit XML and uploads a contract-valid batch', async () => {
    const fetchImpl = okFetch()
    const outcome = await runJunitUpload({
      file: 'junit.xml',
      endpoint: 'https://api.test',
      token: 'fmk_x',
      env: { FLAKEMETRY_PROJECT: 'acme/web', FLAKEMETRY_COMMIT_SHA: 'deadbeef' },
      fetchImpl,
      ...withFile(JUNIT),
    })

    expect(outcome.status).toBe('uploaded')
    expect(outcome.acceptedExecutions).toBe(2)
    expect(fetchImpl).toHaveBeenCalledOnce()
    const call = (fetchImpl as unknown as { mock: { calls: [string, { body: string }][] } }).mock
      .calls[0]
    const body = JSON.parse(call![1].body) as {
      run: { status: string }
      executions: { status: string }[]
    }
    expect(body.executions).toHaveLength(2)
    expect(body.run.status).toBe('failed')
    expect(body.executions[1]?.status).toBe('fail')
  })

  it('fails when the file is missing', async () => {
    const outcome = await runJunitUpload({
      file: 'nope.xml',
      endpoint: 'https://api.test',
      token: 'fmk_x',
      env: {},
      fileExists: () => false,
    })
    expect(outcome.status).toBe('failed')
  })
})
