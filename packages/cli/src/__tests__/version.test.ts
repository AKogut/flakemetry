import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as { version: string }
const built = join(root, 'dist/cli.js')

/**
 * `--version` reported `0.0.0` while the package published `0.2.1`, so every bug report
 * carried a version that identified nothing. The constant is now baked in at build time,
 * and this asserts against the built artifact rather than the source constant — the source
 * cannot tell whether the define reached the bundle.
 */
describe.skipIf(!existsSync(built))('flakemetry --version', () => {
  it('reports the version the package actually publishes', () => {
    const printed = execFileSync('node', [built, '--version'], { encoding: 'utf8' }).trim()

    expect(printed).toBe(manifest.version)
    expect(printed).not.toBe('0.0.0')
  })
})
