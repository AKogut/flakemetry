import { describe, expect, it, vi } from 'vitest'

import {
  createGithubTracker,
  createGitlabTracker,
  createTrackerFor,
  isValidRepository,
} from '../tracker'

interface Call {
  url: string
  method: string
  headers: Record<string, string>
  body: Record<string, unknown>
}

const fakeFetch = (response: unknown = {}) => {
  const calls: Call[] = []
  const fetchImpl = vi.fn(async (url: string, init: RequestInit) => {
    calls.push({
      url,
      method: init.method ?? 'GET',
      headers: init.headers as Record<string, string>,
      body: JSON.parse((init.body as string | undefined) ?? '{}'),
    })
    return { ok: true, status: 200, json: async () => response, text: async () => '' }
  }) as unknown as typeof fetch
  return { calls, fetchImpl }
}

const PROJECT = 'https://gitlab.com/api/v4/projects/acme%2Fplatform%2Fweb'

const gitlab = (response?: unknown) => {
  const { calls, fetchImpl } = fakeFetch(response)
  return {
    calls,
    tracker: createGitlabTracker({ project: 'acme/platform/web', token: 'glpat-x', fetchImpl }),
  }
}

describe('the GitLab tracker', () => {
  it('creates an issue, addressing the project by its encoded path', async () => {
    const { calls, tracker } = gitlab({ iid: 42, id: 9001, web_url: 'https://gitlab.com/i/42' })

    const ticket = await tracker.create({
      title: 'Flaky: logs in',
      body: 'why',
      labels: ['a', 'b'],
    })

    expect(ticket).toEqual({ externalId: '42', url: 'https://gitlab.com/i/42' })
    expect(calls[0]).toMatchObject({
      url: `${PROJECT}/issues`,
      method: 'POST',
      body: { title: 'Flaky: logs in', description: 'why', labels: 'a,b' },
    })
    expect(calls[0]?.headers['private-token']).toBe('glpat-x')
  })

  it('uses the per-project iid, not the global id', async () => {
    const { calls, tracker } = gitlab({ iid: 42, id: 9001 })
    const { externalId } = await tracker.create({ title: 't', body: 'b', labels: [] })
    await tracker.update(externalId, 'new')
    expect(calls[1]?.url).toBe(`${PROJECT}/issues/42`)
  })

  it('updates the description', async () => {
    const { calls, tracker } = gitlab()
    await tracker.update('42', 'new body')
    expect(calls[0]).toMatchObject({ method: 'PUT', body: { description: 'new body' } })
  })

  it('comments through notes', async () => {
    const { calls, tracker } = gitlab()
    await tracker.comment('42', 'hello')
    expect(calls[0]).toMatchObject({
      url: `${PROJECT}/issues/42/notes`,
      method: 'POST',
      body: { body: 'hello' },
    })
  })

  it('closes with a state event, after saying why', async () => {
    const { calls, tracker } = gitlab()
    await tracker.close('42', 'recovered')
    expect(calls.map((call) => call.body)).toEqual([
      { body: 'recovered' },
      { state_event: 'close' },
    ])
  })

  it('reopens with a state event, then says why', async () => {
    const { calls, tracker } = gitlab()
    await tracker.reopen('42', 'flaky again')
    expect(calls.map((call) => call.body)).toEqual([
      { state_event: 'reopen' },
      { body: 'flaky again' },
    ])
  })

  it('reports a refusal instead of swallowing it', async () => {
    const fetchImpl = vi.fn(async () => ({
      ok: false,
      status: 403,
      json: async () => ({}),
      text: async () => 'insufficient scope',
    })) as unknown as typeof fetch
    const tracker = createGitlabTracker({ project: 'a/b', token: 't', fetchImpl })

    await expect(tracker.comment('1', 'x')).rejects.toThrow(/403 insufficient scope/)
  })

  it('refuses a project path that is not one', () => {
    expect(() => createGitlabTracker({ project: 'nope', token: 't' })).toThrow(/group\/name/)
  })

  it('encodes a path, so it cannot walk to another API route', async () => {
    const { calls, fetchImpl } = fakeFetch({ iid: 1 })
    const tracker = createGitlabTracker({ project: '../../admin', token: 't', fetchImpl })
    await tracker.comment('1', 'x')
    expect(calls[0]?.url).toContain('/projects/..%2F..%2Fadmin/')
  })
})

describe('createTrackerFor', () => {
  it('picks GitLab from the prefix and GitHub otherwise', () => {
    expect(createTrackerFor({ repository: 'gitlab:acme/web', token: 't' }).name).toBe('gitlab')
    expect(createTrackerFor({ repository: 'acme/web', token: 't' }).name).toBe('github')
  })

  it('takes a self-managed host from the environment', async () => {
    const { calls, fetchImpl } = fakeFetch()
    const tracker = createTrackerFor({
      repository: 'gitlab:acme/web',
      token: 't',
      env: { FLAKEMETRY_TRACKER_GITLAB_URL: 'https://gitlab.acme.com/' },
      fetchImpl,
    })
    await tracker.comment('1', 'x')
    expect(calls[0]?.url).toBe('https://gitlab.acme.com/api/v4/projects/acme%2Fweb/issues/1/notes')
  })

  it('cannot be pointed at another host from the project, because the token belongs to the instance', () => {
    expect(isValidRepository('gitlab:https://evil.example/acme/web')).toBe(false)
    expect(isValidRepository('gitlab:evil.example:8080/acme')).toBe(false)
    expect(() =>
      createTrackerFor({ repository: 'gitlab:https://evil.example/acme/web', token: 't' }),
    ).toThrow(/group\/name/)
  })
})

describe('isValidRepository', () => {
  it.each([
    ['acme/web', true],
    ['gitlab:acme/web', true],
    ['gitlab:acme/platform/web', true],
    ['acme', false],
    ['acme/web/extra', false],
    ['gitlab:acme', false],
    ['', false],
  ])('%s is %s', (value, expected) => {
    expect(isValidRepository(value)).toBe(expected)
  })
})

describe('the GitHub tracker', () => {
  it('still refuses a GitLab path', () => {
    expect(() => createGithubTracker({ repository: 'gitlab:a/b', token: 't' })).toThrow(/owner/)
  })
})
