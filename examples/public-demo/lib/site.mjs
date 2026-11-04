export const testCaseIdOf = (title) => {
  const match = /TC[-_]([A-Z]+)[-_](\d{3})/.exec(title)
  return match ? `TC-${match[1]}-${match[2]}` : null
}

export const relativeLink = (fromFile, toFile) => {
  const from = fromFile.split('/').slice(0, -1)
  const to = toFile.split('/')
  let shared = 0
  while (shared < from.length && shared < to.length - 1 && from[shared] === to[shared]) shared += 1
  const up = from.slice(shared).map(() => '..')
  return [...up, ...to.slice(shared)].join('/') || toFile
}

export const pageFileFor = (url, projectBase, slug, fingerprintById, limits = {}) => {
  if (!url.pathname.startsWith(`${projectBase}/`)) return null
  const rest = url.pathname.slice(projectBase.length + 1)
  const query = [...url.searchParams.keys()]

  if (['suite-health', 'health', 'cost', 'test-cases'].includes(rest) && query.length === 0) {
    return `${slug}/${rest}.html`
  }
  if (rest === 'runs') {
    if (query.length === 0) return `${slug}/runs.html`
    const cursor = url.searchParams.get('cursor')
    if (query.length === 1 && cursor && limits.allowCursor !== false) {
      return `${slug}/runs-${cursor.slice(0, 8)}.html`
    }
    return null
  }
  if (rest === 'flaky') {
    if (query.length === 0) return `${slug}/flaky.html`
    const filter = url.searchParams.get('filter')
    return query.length === 1 && filter ? `${slug}/flaky-${filter}.html` : null
  }

  const test = /^tests\/([0-9a-f-]{36})$/.exec(rest)
  if (test && query.length === 0) {
    const fingerprint = fingerprintById.get(test[1])
    return fingerprint ? `${slug}/tests/${fingerprint}.html` : null
  }
  const trace = /^tests\/([0-9a-f-]{36})\/executions\/([0-9a-f-]{36})$/.exec(rest)
  if (trace && query.length === 0) {
    const fingerprint = fingerprintById.get(trace[1])
    return fingerprint ? `${slug}/tests/${fingerprint}-${trace[2].slice(0, 8)}.html` : null
  }
  return null
}

export const escapeHtml = (value) =>
  String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
