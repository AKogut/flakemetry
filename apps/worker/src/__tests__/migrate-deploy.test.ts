import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..')
const read = (path: string): string => readFileSync(join(root, path), 'utf8')

describe('published images', () => {
  const dockerfile = read('Dockerfile')

  it.each(['api', 'worker', 'migrate'])('start %s from pruned output, not the build', (target) => {
    expect(dockerfile).toContain(`FROM base AS ${target}\n`)
    expect(dockerfile).not.toContain(`FROM build AS ${target}\n`)
  })

  it('keep the build-time auth placeholder out of image config', () => {
    expect(dockerfile).not.toMatch(/^ENV AUTH_SECRET/m)
    expect(dockerfile).toContain('RUN AUTH_SECRET=build-time-placeholder corepack pnpm turbo')
  })

  it('leave the Prisma CLI and tsx out of the services and in the migrate image', () => {
    const db = JSON.parse(read('packages/db/package.json')) as {
      optionalDependencies: Record<string, string>
    }

    expect(Object.keys(db.optionalDependencies).sort()).toEqual(['prisma', 'tsx'])
    expect(dockerfile).toContain('@flakemetry/api deploy --legacy --prod --no-optional')
    expect(dockerfile).toContain('@flakemetry/worker deploy --legacy --prod --no-optional')
    expect(dockerfile).toContain('@flakemetry/db deploy --legacy --prod /prod/migrate')
  })

  it('let the migrate image run corepack pnpm without a download', () => {
    const migrate = dockerfile.slice(dockerfile.indexOf('AS migrate'), dockerfile.indexOf('AS api'))

    expect(migrate).toContain('COPY --from=pruned /usr/local/share/corepack')
    expect(migrate).toContain('COPY package.json ./')
  })
})

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
