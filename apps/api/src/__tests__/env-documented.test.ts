import { readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..')

const walk = (dir: string, out: string[] = []): string[] => {
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry === 'dist' || entry === '.next' || entry === '.turbo') {
      continue
    }
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) walk(full, out)
    else if (/\.(ts|tsx|mjs)$/.test(entry) && !full.includes('__tests__')) out.push(full)
  }
  return out
}

/**
 * A knob nobody can find is a knob that does not exist. Three of these — the queue
 * visibility timeout and the branch and shard overrides — worked perfectly and were
 * discoverable only by reading source, which is how an operator ends up rebuilding
 * behaviour the platform already has.
 */
const DOCUMENTATION = [
  'docs/configuration.md',
  'docs/architecture.md',
  'docs/threat-model.md',
  'README.md',
].map((file) => {
  try {
    return readFileSync(join(root, file), 'utf8')
  } catch {
    return ''
  }
})

const ACTIONS = ['flakemetry', 'flakemetry-pr-comment', 'flakemetry-gate'].map((name) => {
  try {
    return readFileSync(join(root, '.github/actions', name, 'action.yml'), 'utf8')
  } catch {
    return ''
  }
})

/**
 * Named values rather than knobs, or internal plumbing behind a documented command. Each
 * is here on purpose — the point of the check is that silence has to be chosen.
 */
const NOT_A_KNOB: Readonly<Record<string, string>> = {
  FLAKEMETRY_TOKEN: 'the credential itself, documented everywhere it is used',
  FLAKEMETRY_ENDPOINT: 'the instance URL, same',
  FLAKEMETRY_SEED_FORCE: 'internal to the demo seed, whose documented interface is `pnpm demo`',
}

describe('every FLAKEMETRY_ variable the code reads is documented', () => {
  const found = new Set<string>()
  for (const file of [...walk(join(root, 'apps')), ...walk(join(root, 'packages'))]) {
    const source = readFileSync(file, 'utf8')
    for (const match of source.matchAll(/\bFLAKEMETRY_[A-Z0-9_]+/g)) found.add(match[0])
  }

  it('reads the code it is meant to be checking', () => {
    // Guard the guard: an empty scan documents nothing and complains about nothing.
    expect(found.size).toBeGreaterThan(20)
    expect(found).toContain('FLAKEMETRY_QUEUE_VISIBILITY_MS')
  })

  it('finds each one in the documentation or an action definition', () => {
    const undocumented = [...found]
      .filter((name) => !(name in NOT_A_KNOB))
      .filter((name) => ![...DOCUMENTATION, ...ACTIONS].some((text) => text.includes(name)))
      .sort()

    expect(
      undocumented,
      'document these in docs/configuration.md — a knob nobody can find is a knob that does not exist',
    ).toEqual([])
  })
})
