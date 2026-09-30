import { readdirSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..')
const read = (path: string): string => readFileSync(join(root, path), 'utf8')

const UNIT_SUFFIX: Readonly<Record<string, string>> = { ms: 'milliseconds', s: 'seconds' }

const exportedNames = (source: string): string[] => {
  const names: string[] = []
  const instrument = /create(Counter|Histogram|ObservableGauge)\(\s*'([^']+)'\s*,\s*\{([^}]*)\}/g
  for (const [, kind, name, options] of source.matchAll(instrument)) {
    const base = name!.replaceAll('.', '_')
    const unit = /unit:\s*'([^']+)'/.exec(options!)?.[1]
    const suffixed = unit && UNIT_SUFFIX[unit] ? `${base}_${UNIT_SUFFIX[unit]}` : base
    if (kind === 'Counter') names.push(`${suffixed}_total`)
    else if (kind === 'Histogram')
      names.push(...['bucket', 'count', 'sum'].map((s) => `${suffixed}_${s}`))
    else names.push(suffixed)
  }
  return names
}

const exported = new Set([
  ...exportedNames(read('apps/api/src/telemetry.ts')),
  ...exportedNames(read('apps/worker/src/telemetry.ts')),
])

const observability = 'deploy/observability'
const referencing = [
  `${observability}/grafana/dashboards/flakemetry.json`,
  ...readdirSync(join(root, observability, 'rules')).map(
    (file) => `${observability}/rules/${file}`,
  ),
]

const ingestRoutes = [
  ...read('apps/api/src/app.ts').matchAll(/app\.post\('(\/v1\/(?:ingest[^']*|traces))'/g),
].map((match) => match[1]!)

describe('the reference dashboards and alerts', () => {
  it('read the instruments the code creates', () => {
    expect(exported.size).toBeGreaterThan(20)
    expect(exported).toContain('flakemetry_http_server_duration_milliseconds_bucket')
    expect(exported).toContain('flakemetry_worker_jobs_processed_total')
  })

  it.each(referencing)('%s names only metrics the api and worker export', (file) => {
    const used = [...new Set(read(file).match(/\bflakemetry_[a-z0-9_]+/g) ?? [])]
    expect(used.length).toBeGreaterThan(0)
    expect(used.filter((name) => !exported.has(name))).toEqual([])
  })

  it('count every ingestion route toward the ingestion SLO', () => {
    expect(ingestRoutes.length).toBeGreaterThanOrEqual(4)
    const selector = /route=~"([^"]+)"/.exec(read(`${observability}/rules/flakemetry.rules.yml`))
    const pattern = new RegExp(`^(?:${selector?.[1] ?? '$^'})$`)
    expect(ingestRoutes.filter((route) => !pattern.test(route))).toEqual([])
  })
})
