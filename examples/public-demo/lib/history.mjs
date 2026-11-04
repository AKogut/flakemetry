import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { gunzipSync, gzipSync } from 'node:zlib'

const stamp = (value) => new Date(value).toISOString().replace(/[-:.]/g, '')

const directoryOf = (root, slug) => join(root, slug)

export const knownSources = (root, slug) => {
  mkdirSync(directoryOf(root, slug), { recursive: true })
  return new Set(
    readdirSync(directoryOf(root, slug)).map((name) =>
      name.split('__')[1]?.replace('.json.gz', ''),
    ),
  )
}

export const writeBatch = (root, slug, batch, source) => {
  mkdirSync(directoryOf(root, slug), { recursive: true })
  const name = `${stamp(batch.run.startedAt)}__${source}.json.gz`
  writeFileSync(join(directoryOf(root, slug), name), gzipSync(JSON.stringify(batch), { level: 9 }))
}

export const readBatches = (root, slug) =>
  readdirSync(directoryOf(root, slug))
    .filter((name) => name.endsWith('.json.gz'))
    .sort()
    .map((name) => JSON.parse(gunzipSync(readFileSync(join(directoryOf(root, slug), name)))))
