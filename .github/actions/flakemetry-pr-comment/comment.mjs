import { readFileSync } from 'node:fs'

const MARKER = '<!-- flakemetry:pr-comment -->'

const endpoint = (process.env.FLAKEMETRY_ENDPOINT || '').replace(/\/+$/, '')
const token = process.env.FLAKEMETRY_TOKEN || ''
const githubToken = process.env.GITHUB_TOKEN || ''
const retries = Math.max(1, Number(process.env.FLAKEMETRY_RETRIES || '10') || 10)
const apiBase = (process.env.GITHUB_API_URL || 'https://api.github.com').replace(/\/+$/, '')
const repo = process.env.GITHUB_REPOSITORY || ''

const done = (message) => {
  process.stdout.write(`flakemetry: ${message}\n`)
  process.exit(0)
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

const readEvent = () => {
  const path = process.env.GITHUB_EVENT_PATH
  if (!path) return {}
  try {
    return JSON.parse(readFileSync(path, 'utf8'))
  } catch {
    return {}
  }
}

if (!endpoint || !token) done('skipped — endpoint and token are required')
if (!githubToken) done('skipped — a GitHub token is required to post the comment')

const event = readEvent()
const prNumber = event.pull_request?.number ?? event.number
if (!prNumber) done('skipped — not a pull request, nothing to comment on')

const commitSha =
  process.env.FLAKEMETRY_COMMIT_SHA || event.pull_request?.head?.sha || process.env.GITHUB_SHA || ''
if (!commitSha) done('skipped — no commit sha to summarize')

const fetchSummary = async () => {
  for (let attempt = 1; attempt <= retries; attempt += 1) {
    try {
      const response = await fetch(
        `${endpoint}/v1/runs/summary?commitSha=${encodeURIComponent(commitSha)}`,
        {
          headers: { authorization: `Bearer ${token}` },
        },
      )
      if (response.ok) {
        const body = await response.json()
        if (body.found) return body.markdown
      }
    } catch {
      // transient — retry
    }
    if (attempt < retries) await sleep(3000)
  }
  return null
}

const markdown = await fetchSummary()
if (!markdown) done(`skipped — no processed run found for ${commitSha.slice(0, 7)} yet`)

const gh = (path, init = {}) =>
  fetch(`${apiBase}${path}`, {
    ...init,
    headers: {
      authorization: `Bearer ${githubToken}`,
      accept: 'application/vnd.github+json',
      'x-github-api-version': '2022-11-28',
      'user-agent': 'flakemetry-pr-comment',
      ...(init.body ? { 'content-type': 'application/json' } : {}),
      ...init.headers,
    },
  })

try {
  const listed = await gh(`/repos/${repo}/issues/${prNumber}/comments?per_page=100`)
  const comments = listed.ok ? await listed.json() : []
  const existing = Array.isArray(comments)
    ? comments.find((comment) => typeof comment.body === 'string' && comment.body.includes(MARKER))
    : undefined

  const result = existing
    ? await gh(`/repos/${repo}/issues/comments/${existing.id}`, {
        method: 'PATCH',
        body: JSON.stringify({ body: markdown }),
      })
    : await gh(`/repos/${repo}/issues/${prNumber}/comments`, {
        method: 'POST',
        body: JSON.stringify({ body: markdown }),
      })

  if (!result.ok) done(`skipped — GitHub API returned ${result.status}`)
  done(existing ? 'updated the sticky PR comment' : 'posted the sticky PR comment')
} catch (error) {
  done(`skipped — ${error.message}`)
}
