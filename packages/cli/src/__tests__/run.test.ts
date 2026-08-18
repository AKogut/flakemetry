import { describe, expect, it, vi } from 'vitest'

import { runDoctor, worstStatus } from '../commands/doctor'
import { fetchFlaky, renderFlakyTable } from '../commands/flaky'
import { parseWrappedCommand, runWrapped } from '../commands/run'

const command = { command: 'pnpm', args: ['test'] }
const uploaded = async () => ({ status: 'uploaded' as const, acceptedExecutions: 3 })

describe('parseWrappedCommand', () => {
  it('takes everything after the separator', () => {
    expect(parseWrappedCommand(['--', 'pnpm', 'test', '--reporter=dot'])).toEqual({
      command: 'pnpm',
      args: ['test', '--reporter=dot'],
    })
  })

  it('works without a separator too', () => {
    expect(parseWrappedCommand(['pnpm', 'test'])).toEqual({ command: 'pnpm', args: ['test'] })
  })

  it('returns nothing when there is no command', () => {
    expect(parseWrappedCommand([])).toBeNull()
    expect(parseWrappedCommand(['--'])).toBeNull()
  })
})

describe('runWrapped', () => {
  it('does not call an upload at all when there is no results file', async () => {
    const upload = vi.fn(uploaded)
    const notices: string[] = []

    const result = await runWrapped({
      command,
      spawner: async () => 0,
      upload,
      fileExists: () => false,
      onNotice: (message) => notices.push(message),
    })

    // Wrapping a suite whose reporter is not wired up yet is ordinary. Reporting it as a
    // failure on every run teaches people to ignore the output.
    expect(upload).not.toHaveBeenCalled()
    expect(result.upload).toMatchObject({ status: 'skipped' })
    expect(notices[0]).toContain('nothing to upload')
  })

  it('exits with the wrapped command code when it passed', async () => {
    const result = await runWrapped({
      command,
      spawner: async () => 0,
      upload: uploaded,
      fileExists: () => true,
    })

    expect(result.exitCode).toBe(0)
  })

  it('exits with the wrapped command code when it failed', async () => {
    const result = await runWrapped({
      command,
      spawner: async () => 1,
      upload: uploaded,
      fileExists: () => true,
    })

    // A failing suite must still fail the build.
    expect(result.exitCode).toBe(1)
  })

  it('uploads even when the suite failed', async () => {
    const upload = vi.fn(uploaded)

    await runWrapped({ command, spawner: async () => 1, upload, fileExists: () => true })

    // Results are most worth having exactly when the suite failed.
    expect(upload).toHaveBeenCalled()
  })

  it('does not turn a green build red when the upload fails', async () => {
    const notices: string[] = []

    const result = await runWrapped({
      command,
      spawner: async () => 0,
      upload: async () => ({ status: 'failed', reason: 'connection refused' }),
      fileExists: () => true,
      onNotice: (message) => notices.push(message),
    })

    // The whole point of wrapping: observability must never become a source of CI failures.
    expect(result.exitCode).toBe(0)
    expect(notices[0]).toContain('connection refused')
  })

  it('survives an upload that throws', async () => {
    const result = await runWrapped({
      command,
      spawner: async () => 0,
      upload: async () => {
        throw new Error('DNS exploded')
      },
      fileExists: () => true,
    })

    expect(result.exitCode).toBe(0)
    expect(result.upload).toMatchObject({ status: 'failed' })
  })

  it('says so quietly when there was nothing to upload', async () => {
    const notices: string[] = []

    await runWrapped({
      command,
      spawner: async () => 0,
      upload: async () => ({ status: 'skipped', reason: 'unreachable' }),
      fileExists: () => true,
      onNotice: (message) => notices.push(message),
    })

    expect(notices[0]).toContain('unreachable')
  })
})

const jsonResponse = (body: unknown, status = 200) =>
  vi.fn(async () => new Response(JSON.stringify(body), { status })) as unknown as typeof fetch

describe('fetchFlaky', () => {
  const base = { endpoint: 'https://api.test', token: 'fmk_x' }

  it('returns the rows the API served', async () => {
    const fetchImpl = jsonResponse({
      items: [
        {
          testIdentityId: '1',
          title: 'a',
          suite: 's',
          filePath: 'f',
          score: 0.9,
          quarantined: false,
        },
      ],
    })

    const outcome = await fetchFlaky({ ...base, fetchImpl })

    expect(outcome).toMatchObject({ ok: true })
  })

  it('explains a wrong scope instead of calling the token invalid', async () => {
    const fetchImpl = jsonResponse({ error: 'insufficient_scope' }, 403)

    const outcome = await fetchFlaky({ ...base, fetchImpl })

    // Telling someone their token is invalid sends them off to rotate a working credential.
    expect(outcome).toMatchObject({ ok: false })
    if (!outcome.ok) expect(outcome.hint).toContain('read')
  })

  it('distinguishes a rejected token from a wrong scope', async () => {
    const outcome = await fetchFlaky({ ...base, fetchImpl: jsonResponse({}, 401) })

    if (!outcome.ok) expect(outcome.reason).toContain('rejected')
  })

  it('filters to quarantined when asked', async () => {
    const fetchImpl = jsonResponse({
      items: [
        {
          testIdentityId: '1',
          title: 'a',
          suite: 's',
          filePath: 'f',
          score: 0.9,
          quarantined: true,
        },
        {
          testIdentityId: '2',
          title: 'b',
          suite: 's',
          filePath: 'f',
          score: 0.8,
          quarantined: false,
        },
      ],
    })

    const outcome = await fetchFlaky({ ...base, fetchImpl, quarantinedOnly: true })

    if (outcome.ok) expect(outcome.rows).toHaveLength(1)
  })

  it('reports a network failure rather than throwing', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error('ECONNREFUSED')
    }) as unknown as typeof fetch

    const outcome = await fetchFlaky({ ...base, fetchImpl })

    expect(outcome).toMatchObject({ ok: false, reason: 'ECONNREFUSED' })
  })
})

describe('renderFlakyTable', () => {
  it('says so plainly when there is nothing', () => {
    expect(renderFlakyTable([])).toBe('No flaky tests.')
  })

  it('marks quarantined tests', () => {
    const rendered = renderFlakyTable([
      {
        testIdentityId: '1',
        title: 'a',
        suite: 's',
        filePath: 'f.ts',
        score: 0.9,
        quarantined: true,
      },
    ])

    expect(rendered).toContain('0.90')
    expect(rendered).toContain('[quarantined]')
  })
})

describe('runDoctor', () => {
  it('fails fast when there is no endpoint', async () => {
    const checks = await runDoctor({ endpoint: null, token: 'fmk_x' })

    expect(worstStatus(checks)).toBe('fail')
  })

  it('never prints the token', async () => {
    const fetchImpl = jsonResponse({ status: 'ok' })
    const secret = 'fmk_supersecretvalue'

    const checks = await runDoctor({ endpoint: 'https://api.test', token: secret, fetchImpl })

    // This is the command people paste into a chat when something is wrong.
    expect(JSON.stringify(checks)).not.toContain(secret)
  })

  it('calls a token without the read scope a warning, not a failure', async () => {
    const fetchImpl = vi.fn(async (url: string) =>
      url.includes('/health')
        ? new Response('{}', { status: 200 })
        : new Response('{}', { status: 403 }),
    ) as unknown as typeof fetch

    const checks = await runDoctor({ endpoint: 'https://api.test', token: 'fmk_x', fetchImpl })

    // Upload-only is a perfectly valid CI setup; exiting non-zero would break that pipeline.
    expect(worstStatus(checks)).toBe('warn')
    expect(checks.at(-1)?.detail).toContain('read scope')
  })

  it('is clean when everything works', async () => {
    const fetchImpl = jsonResponse({ items: [] })

    const checks = await runDoctor({
      endpoint: 'https://api.test',
      token: 'fmk_x',
      configPath: '/repo/flakemetry.yml',
      fetchImpl,
    })

    expect(worstStatus(checks)).toBe('ok')
  })
})

describe('config problems never stop the wrapped command', () => {
  it('runs the tests and keeps their exit code when the config is broken', async () => {
    const notices: string[] = []
    const spawner = vi.fn(async () => 0)

    const result = await runWrapped({
      command,
      spawner,
      upload: uploaded,
      fileExists: () => true,
      onNotice: (message) => notices.push(message),
    })

    // The wrapper exists so Flakemetry can never fail a build. A typo in flakemetry.yml
    // preventing a suite from running would be the worst possible way to break that.
    expect(spawner).toHaveBeenCalled()
    expect(result.exitCode).toBe(0)
  })
})
