import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

const LOCATIONS = ['CODEOWNERS', join('.github', 'CODEOWNERS'), join('docs', 'CODEOWNERS')]

export interface FindCodeownersDeps {
  readFile?: (absolutePath: string) => string
}

export const findCodeowners = (
  startDir: string,
  env: Record<string, string | undefined> = process.env,
  deps: FindCodeownersDeps = {},
): string | null => {
  const readFile = deps.readFile ?? ((path: string) => readFileSync(path, 'utf8'))

  const candidates: string[] = []
  if (env.FLAKEMETRY_CODEOWNERS_FILE) candidates.push(env.FLAKEMETRY_CODEOWNERS_FILE)

  let dir = startDir
  for (let depth = 0; depth < 6; depth += 1) {
    for (const location of LOCATIONS) candidates.push(join(dir, location))
    const parent = dirname(dir)
    if (parent === dir) break
    dir = parent
  }

  for (const candidate of candidates) {
    try {
      const content = readFile(candidate)
      if (content.trim().length > 0) return content
    } catch {
      continue
    }
  }
  return null
}

export interface UploadCodeownersParams {
  endpoint: string
  token: string
  content: string
  fetchImpl?: typeof fetch
}

export const uploadCodeowners = async (params: UploadCodeownersParams): Promise<boolean> => {
  const fetchImpl = params.fetchImpl ?? fetch
  const endpoint = params.endpoint.replace(/\/+$/, '')
  const response = await fetchImpl(`${endpoint}/v1/codeowners`, {
    method: 'PUT',
    headers: {
      authorization: `Bearer ${params.token}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({ content: params.content }),
  })
  return response.ok
}
