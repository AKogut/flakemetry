import type { ArtifactRef } from '@flakemetry/contracts'
import { describe, expect, it, vi } from 'vitest'

import { uploadArtifacts } from '../artifacts'

const makeFetch = (puts: string[]) =>
  vi.fn(async (url: string, init: RequestInit) => {
    if (url.endsWith('/v1/artifacts/presign')) {
      const body = JSON.parse(init.body as string) as {
        artifacts: { executionIndex: number; name: string }[]
      }
      return {
        ok: true,
        status: 200,
        json: async () => ({
          items: body.artifacts.map((artifact) => ({
            executionIndex: artifact.executionIndex,
            name: artifact.name,
            key: `org/o/proj/p/run/k/${artifact.executionIndex}/${artifact.name}`,
            uploadUrl: `https://store.local/${artifact.name}`,
          })),
        }),
      } as Response
    }
    puts.push(url)
    return { ok: true, status: 200 } as Response
  }) as unknown as typeof fetch

const readFile = () => new Uint8Array([1, 2, 3, 4])

describe('uploadArtifacts', () => {
  it('presigns, uploads and stamps the ref with key and size', async () => {
    const ref: ArtifactRef = { name: 'shot.png', contentType: 'image/png', path: 'r/shot.png' }
    const puts: string[] = []

    const result = await uploadArtifacts({
      endpoint: 'http://api.local/',
      token: 'fmk_x',
      idempotencyKey: 'k12345678',
      rootDir: '/repo',
      executions: [{ artifacts: [ref] }],
      deps: { fetchImpl: makeFetch(puts), readFile },
    })

    expect(result.uploaded).toBe(1)
    expect(puts).toEqual(['https://store.local/shot.png'])
    expect(ref.key).toBe('org/o/proj/p/run/k/0/shot.png')
    expect(ref.sizeBytes).toBe(4)
  })

  it('skips unsupported content types and already-keyed refs', async () => {
    const refs: ArtifactRef[] = [
      { name: 'evil.exe', contentType: 'application/x-msdownload', path: 'r/evil.exe' },
      { name: 'done.png', contentType: 'image/png', path: 'r/done.png', key: 'already' },
    ]
    const result = await uploadArtifacts({
      endpoint: 'http://api.local',
      token: 'fmk_x',
      idempotencyKey: 'k12345678',
      rootDir: '/repo',
      executions: [{ artifacts: refs }],
      deps: { fetchImpl: makeFetch([]), readFile },
    })
    expect(result.uploaded).toBe(0)
  })

  it('throws when presign is rejected', async () => {
    const fetchImpl = (async () => ({ ok: false, status: 503 })) as unknown as typeof fetch
    await expect(
      uploadArtifacts({
        endpoint: 'http://api.local',
        token: 'fmk_x',
        idempotencyKey: 'k12345678',
        rootDir: '/repo',
        executions: [{ artifacts: [{ name: 'a.png', contentType: 'image/png', path: 'r/a.png' }] }],
        deps: { fetchImpl, readFile },
      }),
    ).rejects.toThrow(/503/)
  })
})
