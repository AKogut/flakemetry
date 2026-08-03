import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { REST_ENDPOINTS, TRPC_PROCEDURES } from '@flakemetry/contracts'
import type { PrismaClient } from '@flakemetry/db'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { buildApp } from '../app'
import { appRouter } from '../trpc/router'

const app = buildApp({ prisma: {} as unknown as PrismaClient, store: null })

beforeAll(async () => {
  await app.ready()
})

afterAll(async () => {
  await app.close()
})

// Fastify prints its routes as a tree, so nested paths like /v1/ingest/junit are
// split across lines. Read the declarations instead: that is where a new route is
// actually added, and it cannot nest away from us.
const declaredPaths = (): string[] => {
  const source = readFileSync(
    resolve(dirname(fileURLToPath(import.meta.url)), '..', 'app.ts'),
    'utf8',
  )
  return [...source.matchAll(/\bapp\.(?:get|post|put|patch|delete)\(\s*'([^']+)'/g)].map(
    (match) => match[1]!,
  )
}

describe('documented API surface', () => {
  it('registers every REST endpoint the reference documents', () => {
    for (const endpoint of REST_ENDPOINTS) {
      expect(
        app.hasRoute({ method: endpoint.method, url: endpoint.path }),
        `${endpoint.method} ${endpoint.path} is documented but not registered`,
      ).toBe(true)
    }
  })

  it('documents every versioned route the app registers', () => {
    const declared = declaredPaths()

    // Guard the guard: were the scan to stop matching, the check below would pass
    // vacuously, so assert it still sees the routes we already know exist.
    for (const endpoint of REST_ENDPOINTS) {
      expect(declared, `route scanning missed ${endpoint.path}`).toContain(endpoint.path)
    }

    const documented = new Set(REST_ENDPOINTS.map((endpoint) => endpoint.path))
    const undocumented = declared.filter((path) => path.startsWith('/v1/') && !documented.has(path))
    expect(
      undocumented,
      'add these routes to REST_ENDPOINTS so the API reference covers them',
    ).toEqual([])
  })

  it('documents exactly the tRPC procedures the router exposes', () => {
    const exposed = Object.keys(appRouter._def.procedures).sort()
    const documented = TRPC_PROCEDURES.map((procedure) => procedure.name).sort()
    expect(documented).toEqual(exposed)
  })
})
