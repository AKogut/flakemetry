import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

import { flakemetryConfigSchema, type NotificationRouting } from '@flakemetry/contracts'
import { parse } from 'yaml'

const CONFIG_FILENAMES = ['flakemetry.yml', 'flakemetry.yaml']

export interface FindRoutingDeps {
  readFile?: (absolutePath: string) => string
  exists?: (absolutePath: string) => boolean
}

export const findNotificationRouting = (
  startDir: string,
  deps: FindRoutingDeps = {},
): NotificationRouting | null => {
  const readFile = deps.readFile ?? ((path: string) => readFileSync(path, 'utf8'))
  const exists = deps.exists ?? ((path: string) => existsSync(path))

  let dir = startDir
  for (let depth = 0; depth < 8; depth += 1) {
    for (const filename of CONFIG_FILENAMES) {
      const candidate = join(dir, filename)
      if (exists(candidate)) {
        const config = flakemetryConfigSchema.parse(parse(readFile(candidate)))
        return config.notifications
      }
    }
    const parent = dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  return null
}

export interface UploadRoutingParams {
  endpoint: string
  token: string
  routing: NotificationRouting
  fetchImpl?: typeof fetch
}

export const uploadNotificationRouting = async (params: UploadRoutingParams): Promise<boolean> => {
  const fetchImpl = params.fetchImpl ?? fetch
  const endpoint = params.endpoint.replace(/\/+$/, '')
  const response = await fetchImpl(`${endpoint}/v1/notifications/routing`, {
    method: 'PUT',
    headers: {
      authorization: `Bearer ${params.token}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify(params.routing),
  })
  return response.ok
}
