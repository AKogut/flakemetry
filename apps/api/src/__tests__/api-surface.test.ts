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

const registeredPaths = (): Set<string> => {
  const printed = app.printRoutes({ commonPrefix: false })
  const paths = new Set<string>()
  for (const line of printed.split('\n')) {
    const match = /\s([^\s│├└─]*\/[^\s(]*)\s+\((.+)\)/.exec(line)
    if (match?.[1]) paths.add(match[1].replace(/\/$/, '') || '/')
  }
  return paths
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
    const documented = new Set(REST_ENDPOINTS.map((endpoint) => endpoint.path))
    const undocumented = [...registeredPaths()].filter(
      (path) => path.startsWith('/v1/') && !documented.has(path),
    )
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
