import { readdirSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..')

/**
 * The list of packages needing a changeset had drifted in both directions: it named `ai`,
 * which is private, and omitted the Vitest and Jest reporters, which are published. A
 * contributor following it would either write a changeset nobody needs or miss one that
 * gates a release.
 */
const publishedPackages = (): string[] => {
  const dir = join(root, 'packages')
  const names: string[] = []
  for (const entry of readdirSync(dir)) {
    try {
      const manifest = JSON.parse(readFileSync(join(dir, entry, 'package.json'), 'utf8')) as {
        name?: string
        private?: boolean
      }
      if (manifest.name && !manifest.private) names.push(manifest.name)
    } catch {
      continue
    }
  }
  return names.sort()
}

describe('CONTRIBUTING lists the packages that actually publish', () => {
  const guide = readFileSync(join(root, 'CONTRIBUTING.md'), 'utf8')
  const published = publishedPackages()

  it('reads the workspace it is meant to be checking', () => {
    // Guard the guard: an empty list would agree with any document at all.
    expect(published.length).toBeGreaterThan(4)
    expect(published).toContain('@flakemetry/contracts')
  })

  it('names every published package', () => {
    const missing = published.filter((name) => !guide.includes(name.replace('@flakemetry/', '')))
    expect(missing, 'these publish but the changeset section does not mention them').toEqual([])
  })

  it('does not ask for a changeset on a package that never publishes', () => {
    // Only the list itself, not the surrounding prose — the section deliberately names `db`
    // as an example of something that needs no changeset, and flagging that would be the
    // check misreading its own subject.
    const line =
      guide.split('\n').find((candidate) => candidate.includes('`@flakemetry/contracts` ·')) ?? ''
    expect(line, 'the changeset list was not found — this check has lost its subject').not.toBe('')

    const privateNames = readdirSync(join(root, 'packages')).filter((entry) => {
      try {
        const manifest = JSON.parse(
          readFileSync(join(root, 'packages', entry, 'package.json'), 'utf8'),
        ) as { private?: boolean }
        return manifest.private === true
      } catch {
        return false
      }
    })

    const wrongly = privateNames.filter((entry) => new RegExp(`\`${entry}\``).test(line))
    expect(wrongly, 'these are private and need no changeset').toEqual([])
  })
})

describe('the development guide maps every workspace', () => {
  const guide = readFileSync(join(root, 'apps/docs/contributing/development.md'), 'utf8')
  const rows = new Map<string, string>()
  for (const match of guide.matchAll(/^\| `((?:apps|packages)\/[\w-]+)` \|.*\| (yes|no) \|$/gm)) {
    rows.set(match[1] ?? '', match[2] ?? '')
  }

  const workspaces = ['apps', 'packages'].flatMap((group) =>
    readdirSync(join(root, group))
      .filter((entry) => {
        try {
          readFileSync(join(root, group, entry, 'package.json'), 'utf8')
          return true
        } catch {
          return false
        }
      })
      .map((entry) => `${group}/${entry}`),
  )

  const published = (workspace: string): boolean => {
    const manifest = JSON.parse(readFileSync(join(root, workspace, 'package.json'), 'utf8')) as {
      private?: boolean
    }
    return manifest.private !== true
  }

  it('reads the map it is meant to be checking', () => {
    expect(rows.size).toBeGreaterThan(10)
    expect(workspaces.length).toBeGreaterThan(10)
  })

  it('has a row for every app and package', () => {
    expect(workspaces.filter((workspace) => !rows.has(workspace))).toEqual([])
  })

  it('has no row for a workspace that does not exist', () => {
    expect([...rows.keys()].filter((workspace) => !workspaces.includes(workspace))).toEqual([])
  })

  it('marks exactly the published packages as published', () => {
    const wrong = workspaces.filter(
      (workspace) =>
        rows.has(workspace) && (rows.get(workspace) === 'yes') !== published(workspace),
    )
    expect(wrong, 'the Published column disagrees with package.json').toEqual([])
  })
})
