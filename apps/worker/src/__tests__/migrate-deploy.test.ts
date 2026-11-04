import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..')
const read = (path: string): string => readFileSync(join(root, path), 'utf8')

describe('production deployments', () => {
  it('migrate the single-host stack without loading demo data', () => {
    const compose = read('deploy/compose/docker-compose.yml')
    const service = compose.slice(compose.indexOf('\n  migrate:'), compose.indexOf('\n  api:'))

    expect(service).toContain('prisma migrate deploy')
    expect(service).not.toContain('seed')
  })

  it('migrate the Helm release without loading demo data', () => {
    const job = read('deploy/helm/flakemetry/templates/migrate-job.yaml')

    expect(job).toContain('prisma migrate deploy')
    expect(job).not.toContain('seed')
  })

  it('keep the demo data in the quickstart, which uses the image default', () => {
    const dockerfile = read('Dockerfile')
    const compose = read('docker-compose.yml')
    const service = compose.slice(compose.indexOf('\n  migrate:'), compose.indexOf('\n  api:'))

    expect(dockerfile).toContain('prisma/seed.ts')
    expect(service).not.toContain('command:')
  })
})
