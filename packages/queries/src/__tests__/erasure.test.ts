import type { PrismaClient } from '@flakemetry/db'
import { describe, expect, it, vi } from 'vitest'

import { type ArtifactSweeper, eraseArtifacts, haltIngestion, scopeColumn } from '../erasure'

const sweeper = (keys: string[]): ArtifactSweeper & { removed: string[][] } => {
  const removed: string[][] = []
  return {
    removed,
    list: async () => keys.map((key) => ({ key })),
    remove: async (batch) => {
      removed.push(batch)
    },
  }
}

describe('scopeColumn', () => {
  it('erases a project by project id and a workspace by org id', () => {
    expect(scopeColumn('project')).toBe('project_id')
    expect(scopeColumn('org')).toBe('org_id')
  })
})

describe('eraseArtifacts', () => {
  it('removes everything under the prefix', async () => {
    const store = sweeper(['a/1.png', 'a/2.png'])

    expect(await eraseArtifacts(store, 'a/')).toBe(2)
    expect(store.removed.flat()).toEqual(['a/1.png', 'a/2.png'])
  })

  it('batches so a large bucket does not become one enormous request', async () => {
    const store = sweeper(Array.from({ length: 2500 }, (_, index) => `a/${index}.png`))

    await eraseArtifacts(store, 'a/')

    expect(store.removed.map((batch) => batch.length)).toEqual([1000, 1000, 500])
  })

  it('does nothing when the prefix is empty', async () => {
    const store = sweeper([])

    expect(await eraseArtifacts(store, 'a/')).toBe(0)
    expect(store.removed).toEqual([])
  })
})

describe('haltIngestion', () => {
  const prismaWith = (updateMany: ReturnType<typeof vi.fn>): PrismaClient =>
    ({ ingestToken: { updateMany } }) as unknown as PrismaClient

  it('revokes only the project tokens when a project is being erased', async () => {
    const updateMany = vi.fn(async (_args: unknown) => ({ count: 2 }))

    const revoked = await haltIngestion(prismaWith(updateMany), { kind: 'project', id: 'p1' })

    expect(revoked).toBe(2)
    expect(updateMany.mock.calls[0]?.[0]).toMatchObject({
      where: { projectId: 'p1', revokedAt: null },
    })
  })

  it('revokes the whole workspace when the workspace is being erased', async () => {
    const updateMany = vi.fn(async (_args: unknown) => ({ count: 5 }))

    await haltIngestion(prismaWith(updateMany), { kind: 'org', id: 'o1' })

    expect(updateMany.mock.calls[0]?.[0]).toMatchObject({ where: { orgId: 'o1', revokedAt: null } })
  })

  it('leaves an already revoked token alone', async () => {
    const updateMany = vi.fn(async (_args: unknown) => ({ count: 0 }))

    await haltIngestion(prismaWith(updateMany), { kind: 'project', id: 'p1' })

    // Re-revoking would move revokedAt and lose when the token actually stopped working.
    expect(updateMany.mock.calls[0]?.[0]).toMatchObject({ where: { revokedAt: null } })
  })
})
