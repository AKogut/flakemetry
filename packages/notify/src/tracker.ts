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

export const isValidRepository = (value: string): boolean => REPOSITORY_PATTERN.test(value)

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
  if (!isValidRepository(options.repository)) {
    throw new Error(`repository must look like owner/name, got "${options.repository}"`)
  }
  return new GithubTracker(options)
}

/**
 * Null when no token is configured, which is what keeps the whole feature off by default —
 * an instance that has not been given credentials must never half-file tickets.
 */
export const resolveTrackerToken = (env: Record<string, string | undefined>): string | null => {
  const token = env.FLAKEMETRY_TRACKER_TOKEN?.trim()
  return token ? token : null
}
