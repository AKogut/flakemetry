import { describe, expect, it } from 'vitest'

import { createMemoryObjectStore } from '../memory'
import { resolveObjectStore } from '../resolve'
import { pruneArtifacts } from '../retention'
import { artifactKey, projectArtifactPrefix, sanitizeSegment } from '../store'

describe('artifact keys', () => {
  it('namespaces by org, project, run, execution index and sanitizes the name', () => {
    const key = artifactKey({
      orgId: 'org-1',
      projectId: 'proj-1',
      idempotencyKey: 'gh-42-1',
      executionIndex: 3,
      name: 'trace file.zip',
    })
    expect(key).toBe('org/org-1/proj/proj-1/run/gh-42-1/3/trace-file.zip')
    expect(key.startsWith(projectArtifactPrefix('org-1', 'proj-1'))).toBe(true)
  })

  it('never lets a name escape its prefix', () => {
    expect(sanitizeSegment('../../etc/passwd')).toBe('etc-passwd')
    expect(sanitizeSegment('   ')).toBe('artifact')
  })
})

describe('memory object store', () => {
  it('stores, lists and presigns objects', async () => {
    const store = createMemoryObjectStore()
    await store.put('org/o/proj/p/run/r/0/shot.png', new Uint8Array([1, 2, 3]), 'image/png')

    const listed = await store.list('org/o/proj/p/')
    expect(listed).toHaveLength(1)
    expect(listed[0]?.size).toBe(3)

    expect(await store.presignUpload('k', 'image/png')).toContain('upload=1')
    expect(await store.presignDownload('k')).toContain('/k?')
  })
})

describe('retention', () => {
  it('deletes only objects older than the cutoff', async () => {
    let clock = new Date('2026-07-01T00:00:00Z')
    const store = createMemoryObjectStore({ now: () => clock })

    await store.put('org/o/proj/p/run/old/0/a.png', new Uint8Array([1]), 'image/png')
    clock = new Date('2026-07-29T00:00:00Z')
    await store.put('org/o/proj/p/run/new/0/b.png', new Uint8Array([1]), 'image/png')

    const result = await pruneArtifacts(store, {
      olderThanDays: 14,
      now: new Date('2026-07-30T00:00:00Z'),
    })

    expect(result.scanned).toBe(2)
    expect(result.deleted).toEqual(['org/o/proj/p/run/old/0/a.png'])
    expect((await store.list('')).map((o) => o.key)).toEqual(['org/o/proj/p/run/new/0/b.png'])
  })
})

describe('resolveObjectStore', () => {
  it('returns null when no bucket is configured', () => {
    expect(resolveObjectStore({})).toBeNull()
  })

  it('builds an s3 store with path-style for a MinIO endpoint', () => {
    let seen: unknown
    const store = resolveObjectStore(
      {
        FLAKEMETRY_S3_BUCKET: 'artifacts',
        FLAKEMETRY_S3_ENDPOINT: 'http://localhost:9000',
        FLAKEMETRY_S3_FORCE_PATH_STYLE: 'true',
      },
      {
        createS3: (options) => {
          seen = options
          return createMemoryObjectStore()
        },
      },
    )
    expect(store).not.toBeNull()
    expect(seen).toMatchObject({ bucket: 'artifacts', forcePathStyle: true })
  })
})
