export interface TrackerTicket {
  externalId: string
  url: string
}

export interface TrackerProvider {
  readonly name: string
  create: (input: { title: string; body: string; labels: string[] }) => Promise<TrackerTicket>
  update: (externalId: string, body: string) => Promise<void>
  comment: (externalId: string, body: string) => Promise<void>
  close: (externalId: string, comment: string) => Promise<void>
  reopen: (externalId: string, comment: string) => Promise<void>
}

export interface GithubTrackerOptions {
  repository: string
  token: string
  apiBase?: string
  fetchImpl?: typeof fetch
}

const REPOSITORY_PATTERN = /^[\w.-]+\/[\w.-]+$/
const GITLAB_PREFIX = 'gitlab:'
const GITLAB_PROJECT_PATTERN = /^[\w.-]+(?:\/[\w.-]+)+$/

const isGitlabRepository = (value: string): boolean =>
  value.startsWith(GITLAB_PREFIX) && GITLAB_PROJECT_PATTERN.test(value.slice(GITLAB_PREFIX.length))

export const isValidRepository = (value: string): boolean =>
  REPOSITORY_PATTERN.test(value) || isGitlabRepository(value)

class GithubTracker implements TrackerProvider {
  readonly name = 'github'
  private readonly apiBase: string
  private readonly fetchImpl: typeof fetch

  constructor(private readonly options: GithubTrackerOptions) {
    this.apiBase = options.apiBase ?? 'https://api.github.com'
    this.fetchImpl = options.fetchImpl ?? fetch
  }

  private async request(path: string, method: string, body?: unknown): Promise<unknown> {
    const response = await this.fetchImpl(
      `${this.apiBase}/repos/${this.options.repository}${path}`,
      {
        method,
        headers: {
          authorization: `Bearer ${this.options.token}`,
          accept: 'application/vnd.github+json',
          'content-type': 'application/json',
          'x-github-api-version': '2022-11-28',
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      },
    )
    if (!response.ok) {
      const detail = await response.text().catch(() => '')
      throw new Error(`github ${method} ${path} failed: ${response.status} ${detail.slice(0, 200)}`)
    }
    return response.json().catch(() => ({}))
  }

  async create(input: { title: string; body: string; labels: string[] }): Promise<TrackerTicket> {
    const created = (await this.request('/issues', 'POST', input)) as {
      number?: number
      html_url?: string
    }
    if (created.number === undefined) throw new Error('github issue create returned no number')
    return { externalId: String(created.number), url: created.html_url ?? '' }
  }

  async update(externalId: string, body: string): Promise<void> {
    await this.request(`/issues/${externalId}`, 'PATCH', { body })
  }

  async comment(externalId: string, body: string): Promise<void> {
    await this.request(`/issues/${externalId}/comments`, 'POST', { body })
  }

  async close(externalId: string, comment: string): Promise<void> {
    await this.comment(externalId, comment)
    await this.request(`/issues/${externalId}`, 'PATCH', {
      state: 'closed',
      state_reason: 'completed',
    })
  }

  async reopen(externalId: string, comment: string): Promise<void> {
    await this.request(`/issues/${externalId}`, 'PATCH', { state: 'open' })
    await this.comment(externalId, comment)
  }
}

export const createGithubTracker = (options: GithubTrackerOptions): TrackerProvider => {
  if (!REPOSITORY_PATTERN.test(options.repository)) {
    throw new Error(`repository must look like owner/name, got "${options.repository}"`)
  }
  return new GithubTracker(options)
}

export interface GitlabTrackerOptions {
  project: string
  token: string
  apiBase?: string
  fetchImpl?: typeof fetch
}

class GitlabTracker implements TrackerProvider {
  readonly name = 'gitlab'
  private readonly projectUrl: string
  private readonly fetchImpl: typeof fetch

  constructor(private readonly options: GitlabTrackerOptions) {
    const base = (options.apiBase ?? 'https://gitlab.com').replace(/\/+$/, '')
    this.projectUrl = `${base}/api/v4/projects/${encodeURIComponent(options.project)}`
    this.fetchImpl = options.fetchImpl ?? fetch
  }

  private async request(path: string, method: string, body: unknown): Promise<unknown> {
    const response = await this.fetchImpl(`${this.projectUrl}${path}`, {
      method,
      headers: {
        'private-token': this.options.token,
        'content-type': 'application/json',
      },
      body: JSON.stringify(body),
    })
    if (!response.ok) {
      const detail = await response.text().catch(() => '')
      throw new Error(`gitlab ${method} ${path} failed: ${response.status} ${detail.slice(0, 200)}`)
    }
    return response.json().catch(() => ({}))
  }

  async create(input: { title: string; body: string; labels: string[] }): Promise<TrackerTicket> {
    const created = (await this.request('/issues', 'POST', {
      title: input.title,
      description: input.body,
      labels: input.labels.join(','),
    })) as { iid?: number; web_url?: string }
    if (created.iid === undefined) throw new Error('gitlab issue create returned no iid')
    return { externalId: String(created.iid), url: created.web_url ?? '' }
  }

  async update(externalId: string, body: string): Promise<void> {
    await this.request(`/issues/${externalId}`, 'PUT', { description: body })
  }

  async comment(externalId: string, body: string): Promise<void> {
    await this.request(`/issues/${externalId}/notes`, 'POST', { body })
  }

  async close(externalId: string, comment: string): Promise<void> {
    await this.comment(externalId, comment)
    await this.request(`/issues/${externalId}`, 'PUT', { state_event: 'close' })
  }

  async reopen(externalId: string, comment: string): Promise<void> {
    await this.request(`/issues/${externalId}`, 'PUT', { state_event: 'reopen' })
    await this.comment(externalId, comment)
  }
}

export const createGitlabTracker = (options: GitlabTrackerOptions): TrackerProvider => {
  if (!GITLAB_PROJECT_PATTERN.test(options.project)) {
    throw new Error(`project must look like group/name, got "${options.project}"`)
  }
  return new GitlabTracker(options)
}

export interface TrackerFromRepositoryOptions {
  repository: string
  token: string
  env?: Record<string, string | undefined>
  fetchImpl?: typeof fetch
}

export const createTrackerFor = (options: TrackerFromRepositoryOptions): TrackerProvider => {
  if (options.repository.startsWith(GITLAB_PREFIX)) {
    return createGitlabTracker({
      project: options.repository.slice(GITLAB_PREFIX.length),
      token: options.token,
      apiBase: options.env?.FLAKEMETRY_TRACKER_GITLAB_URL?.trim() || undefined,
      fetchImpl: options.fetchImpl,
    })
  }
  return createGithubTracker({
    repository: options.repository,
    token: options.token,
    fetchImpl: options.fetchImpl,
  })
}

/**
 * Null when no token is configured, which is what keeps the whole feature off by default —
 * an instance that has not been given credentials must never half-file tickets.
 */
export const resolveTrackerToken = (env: Record<string, string | undefined>): string | null => {
  const token = env.FLAKEMETRY_TRACKER_TOKEN?.trim()
  return token ? token : null
}
