import { appendFileSync, readFileSync } from 'node:fs'

const MARKER = '<!-- flakemetry:pr-gate -->'
const STATUS_CONTEXT = 'flakemetry/gate'

const endpoint = (process.env.FLAKEMETRY_ENDPOINT || '').replace(/\/+$/, '')
const token = process.env.FLAKEMETRY_TOKEN || ''
const githubToken = process.env.GITHUB_TOKEN || ''
const strictness = process.env.FLAKEMETRY_STRICTNESS || 'new'
const failOnGate = (process.env.FLAKEMETRY_FAIL_ON_GATE || 'true') !== 'false'
const retries = Math.max(1, Number(process.env.FLAKEMETRY_RETRIES || '10') || 10)
const apiBase = (process.env.GITHUB_API_URL || 'https://api.github.com').replace(/\/+$/, '')
const repo = process.env.GITHUB_REPOSITORY || ''

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

const note = (message) => process.stdout.write(`flakemetry-gate: ${message}\n`)

const skip = (message) => {
  note(`skipped — ${message}`)
  process.exit(0)
}

const summary = (text) => {
  if (process.env.GITHUB_STEP_SUMMARY) {
    try {
      appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${text}\n`)
    } catch {}
  }
}

const readEvent = () => {
  const path = process.env.GITHUB_EVENT_PATH
  if (!path) return {}
  try {
    return JSON.parse(readFileSync(path, 'utf8'))
  } catch {
    return {}
  }
}

if (!endpoint || !token) skip('endpoint and token are required')

const event = readEvent()
const commitSha =
  process.env.FLAKEMETRY_COMMIT_SHA || event.pull_request?.head?.sha || process.env.GITHUB_SHA || ''
if (!commitSha) skip('no commit sha to gate')

const baseBranch = process.env.FLAKEMETRY_BASE_BRANCH || event.pull_request?.base?.ref || ''
if (!baseBranch) skip('no base branch to compare against')

const fetchGate = async () => {
  const url = `${endpoint}/v1/runs/gate?commitSha=${encodeURIComponent(commitSha)}&baseBranch=${encodeURIComponent(
    baseBranch,
  )}&strictness=${encodeURIComponent(strictness)}`
  for (let attempt = 1; attempt <= retries; attempt += 1) {
    try {
      const response = await fetch(url, { headers: { authorization: `Bearer ${token}` } })
      if (response.ok) {
        const body = await response.json()
        if (body.found) return body
      }
    } catch {}
    if (attempt < retries) await sleep(3000)
  }
  return null
}

const gh = (path, init = {}) =>
  fetch(`${apiBase}${path}`, {
    ...init,
    headers: {
      authorization: `Bearer ${githubToken}`,
      accept: 'application/vnd.github+json',
      'x-github-api-version': '2022-11-28',
      'user-agent': 'flakemetry-gate',
      ...(init.body ? { 'content-type': 'application/json' } : {}),
      ...init.headers,
    },
  })

const postComment = async (markdown, prNumber) => {
  if (!githubToken || !prNumber) return
  try {
    const listed = await gh(`/repos/${repo}/issues/${prNumber}/comments?per_page=100`)
    const comments = listed.ok ? await listed.json() : []
    const existing = Array.isArray(comments)
      ? comments.find(
          (comment) => typeof comment.body === 'string' && comment.body.includes(MARKER),
        )
      : undefined
    if (existing) {
      await gh(`/repos/${repo}/issues/comments/${existing.id}`, {
        method: 'PATCH',
        body: JSON.stringify({ body: markdown }),
      })
    } else {
      await gh(`/repos/${repo}/issues/${prNumber}/comments`, {
        method: 'POST',
        body: JSON.stringify({ body: markdown }),
      })
    }
  } catch {}
}

const postStatus = async (state, description) => {
  if (!githubToken || !repo) return
  try {
    await gh(`/repos/${repo}/statuses/${commitSha}`, {
      method: 'POST',
      body: JSON.stringify({ state, context: STATUS_CONTEXT, description }),
    })
  } catch {}
}

const result = await fetchGate()
if (!result) skip(`no processed run found for ${commitSha.slice(0, 7)} yet`)

const gate = result.gate
const prNumber = event.pull_request?.number ?? event.number
const description =
  gate.verdict === 'block'
    ? `${gate.newFailures} new failure(s), ${gate.knownFlakes} known flake(s)`
    : `no new failures, ${gate.knownFlakes} known flake(s)`

await postComment(result.markdown, prNumber)
await postStatus(gate.verdict === 'block' ? 'failure' : 'success', description)
summary(result.markdown)

if (gate.verdict === 'block') {
  note(`blocked — ${description}`)
  if (failOnGate) process.exit(1)
  process.exit(0)
}

note(`passed — ${description}`)
