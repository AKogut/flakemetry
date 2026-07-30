export interface CodeownersRule {
  pattern: string
  owners: string[]
  regex: RegExp
}

const escapeLiteral = (char: string): string => (/[.+^${}()|[\]\\]/.test(char) ? `\\${char}` : char)

const translate = (glob: string): string => {
  let out = ''
  for (let i = 0; i < glob.length; i += 1) {
    const char = glob[i]!
    if (char === '*') {
      if (glob[i + 1] === '*') {
        i += 1
        if (glob[i + 1] === '/') {
          i += 1
          out += '(?:.*/)?'
        } else {
          out += '.*'
        }
      } else {
        out += '[^/]*'
      }
    } else if (char === '?') {
      out += '[^/]'
    } else {
      out += escapeLiteral(char)
    }
  }
  return out
}

const compile = (pattern: string): RegExp => {
  const anchored = pattern.startsWith('/') || pattern.replace(/\/$/, '').includes('/')
  let body = pattern.replace(/^\//, '')
  const dirOnly = body.endsWith('/')
  if (dirOnly) body = body.replace(/\/$/, '')
  const prefix = anchored ? '^' : '^(?:.*/)?'
  const suffix = dirOnly ? '(?:/.*)?$' : '$'
  return new RegExp(prefix + translate(body) + suffix)
}

export const parseCodeowners = (text: string): CodeownersRule[] => {
  const rules: CodeownersRule[] = []
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim()
    if (line.length === 0 || line.startsWith('#')) continue
    const parts = line.split(/\s+/)
    const pattern = parts[0]!
    const owners = parts.slice(1).filter((owner) => owner.length > 0)
    if (owners.length === 0) continue
    try {
      rules.push({ pattern, owners, regex: compile(pattern) })
    } catch {
      continue
    }
  }
  return rules
}

export const matchCodeowners = (rules: readonly CodeownersRule[], filePath: string): string[] => {
  const normalized = filePath.replace(/^\.?\//, '')
  let owners: string[] = []
  for (const rule of rules) {
    if (rule.regex.test(normalized)) owners = rule.owners
  }
  return owners
}
