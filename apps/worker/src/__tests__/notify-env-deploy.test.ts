import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..')
const read = (path: string): string => readFileSync(join(root, path), 'utf8')

const usedBy = (source: string): string[] => [
  ...new Set(
    [...source.matchAll(/env\.(FLAKEMETRY_[A-Z_]+)/g)]
      .map((match) => match[1] as string)
      .filter((name) => /WEBHOOK|EMAIL|NOTIFY|DASHBOARD|SMTP/.test(name)),
  ),
]

const workerBlock = (compose: string): string => {
  const start = compose.indexOf('\n  worker:\n')
  const end = compose.indexOf('\n  web:\n', start)
  return compose.slice(start, end)
}

describe('the notification settings reach the worker', () => {
  const variables = usedBy(read('apps/worker/src/notify.ts') + read('packages/notify/src/email.ts'))

  it('finds the variables it is checking', () => {
    expect(variables).toEqual(
      expect.arrayContaining(['FLAKEMETRY_DISCORD_WEBHOOK', 'FLAKEMETRY_DASHBOARD_URL']),
    )
    expect(variables.some((name) => name.startsWith('FLAKEMETRY_SMTP_'))).toBe(true)
  })

  it.each(['docker-compose.yml', 'deploy/compose/docker-compose.yml'])(
    '%s passes every one of them through',
    (file) => {
      const worker = workerBlock(read(file))
      for (const name of variables) expect(worker, name).toContain(`${name}:`)
    },
  )
})
