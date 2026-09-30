const TEST_POINT = /^(\s*)(not )?ok\s+\d+(?:\s+-\s+(.*?))?(?:\s+#\s+(SKIP|TODO)\b.*)?\s*$/i
const SUBTEST = /^(\s*)#\s+Subtest:\s+(.*)$/

const unquote = (raw) => {
  const value = raw.trim()
  if (value.startsWith("'") && value.endsWith("'")) return value.slice(1, -1).replace(/''/g, "'")
  if (value.startsWith('"') && value.endsWith('"')) {
    try {
      return JSON.parse(value)
    } catch {
      return value.slice(1, -1)
    }
  }
  return value
}

const indentOf = (line) => line.length - line.trimStart().length

const readDiagnostics = (lines, start) => {
  const fields = {}
  if (lines[start]?.trim() !== '---') return { fields, next: start }
  const base = indentOf(lines[start])
  let index = start + 1
  while (index < lines.length && lines[index].trim() !== '...') {
    const line = lines[index]
    const match = /^([A-Za-z_]+):\s?(.*)$/.exec(line.trim())
    if (match && indentOf(line) === base) {
      const [, key, value] = match
      if (value === '|-' || value === '|') {
        const block = []
        index += 1
        while (
          index < lines.length &&
          indentOf(lines[index]) > base &&
          lines[index].trim() !== '...'
        ) {
          block.push(lines[index].trim())
          index += 1
        }
        fields[key] = block.join('\n')
        continue
      }
      fields[key] = unquote(value)
    }
    index += 1
  }
  return { fields, next: index + 1 }
}

export default {
  name: 'tap',
  apiVersion: 1,
  parse(content) {
    const lines = content.split(/\r?\n/)
    const open = []
    const executions = []

    let index = 0
    while (index < lines.length) {
      const line = lines[index]
      const subtest = SUBTEST.exec(line)
      if (subtest) {
        open.push({ indent: subtest[1].length, name: subtest[2].trim() })
        index += 1
        continue
      }

      const point = TEST_POINT.exec(line)
      if (!point) {
        index += 1
        continue
      }

      const indent = point[1].length
      const ancestors = open.filter((entry) => entry.indent < indent).map((entry) => entry.name)
      while (open.length > 0 && open[open.length - 1].indent >= indent) open.pop()

      const { fields, next } = readDiagnostics(lines, index + 1)
      index = next
      if (fields.type === 'suite') continue

      const failed = Boolean(point[2])
      const skipped = Boolean(point[4])
      const message = fields.error || 'test failed'
      executions.push({
        filePath: 'tap',
        suite: ancestors.join(' › '),
        title: (point[3] ?? '').replace(/\\#/g, '#') || 'unnamed test',
        status: skipped ? 'skip' : failed ? 'fail' : 'pass',
        durationMs: Math.round(Number(fields.duration_ms ?? 0)) || 0,
        error:
          failed && !skipped
            ? { type: fields.name ?? null, message, stack: fields.stack ?? null }
            : null,
      })
    }

    return { startedAt: null, executions }
  },
}
