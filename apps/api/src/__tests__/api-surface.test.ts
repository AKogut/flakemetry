import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { REST_ENDPOINTS, TRPC_PROCEDURES } from '@flakemetry/contracts'
import type { PrismaClient } from '@flakemetry/db'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { buildApp } from '../app'
import { openApiDocument, READ_ROUTES } from '../rest'
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
  const inApp = [...source.matchAll(/\bapp\.(?:get|post|put|patch|delete)\(\s*'([^']+)'/g)].map(
    (match) => match[1]!,
  )
  // The read API registers its routes from a table in rest.ts rather than inline, so a scan
  // of app.ts alone would let every one of them escape this check entirely.
  return [...inApp, ...READ_ROUTES.map((route) => route.path), '/openapi.json']
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

describe('the machine-readable description covers the whole surface', () => {
  const document = openApiDocument('0.0.0') as {
    paths: Record<string, Record<string, { requestBody?: unknown; security?: unknown[] }>>
  }

  it('describes every documented endpoint, not only the readable half', () => {
    // It used to be generated from READ_ROUTES, so ingestion, the quality gate and
    // quarantine were invisible to anything generating a client — with nothing in the
    // document to say a client was seeing a fraction of the API.
    const missing = REST_ENDPOINTS.filter((endpoint) => {
      const path = endpoint.path.replace(/:(\w+)/g, '{$1}')
      return !document.paths[path]?.[endpoint.method.toLowerCase()]
    }).map((endpoint) => `${endpoint.method} ${endpoint.path}`)

    expect(missing).toEqual([])
  })

  it('describes the body of every endpoint that takes one', () => {
    for (const endpoint of REST_ENDPOINTS.filter((candidate) => candidate.request)) {
      const path = endpoint.path.replace(/:(\w+)/g, '{$1}')
      const operation = document.paths[path]?.[endpoint.method.toLowerCase()]
      expect(operation?.requestBody, `${endpoint.path} has no requestBody`).toBeDefined()
    }
  })

  it('leaves the unauthenticated endpoints unauthenticated', () => {
    const health = document.paths['/health']?.get
    const ingest = document.paths['/v1/ingest']?.post

    // A document that demands a token for the liveness probe teaches people to ignore its
    // security blocks entirely.
    expect(health?.security).toEqual([])
    expect(ingest?.security).not.toEqual([])
  })

  it('declares every path parameter it names', () => {
    const undeclared: string[] = []
    for (const [path, operations] of Object.entries(document.paths)) {
      const named = [...path.matchAll(/\{(\w+)\}/g)].map((match) => match[1])
      for (const [method, operation] of Object.entries(operations)) {
        const params = ((operation as { parameters?: { name: string; in: string }[] }).parameters ??
          []) as { name: string; in: string }[]
        for (const name of named) {
          if (!params.some((param) => param.name === name && param.in === 'path')) {
            undeclared.push(`${method.toUpperCase()} ${path} → ${name}`)
          }
        }
      }
    }
    // A path with an undeclared parameter is a URL no generated client can build.
    expect(undeclared).toEqual([])
  })
})
