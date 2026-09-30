import { readFileSync } from 'node:fs'

import { describe, expect, it } from 'vitest'

const manifest = JSON.parse(
  readFileSync(new URL('../../package.json', import.meta.url), 'utf8'),
) as { peerDependencies: Record<string, string> }

describe('the Vitest versions this reporter can be installed with', () => {
  it('admits every major it was verified on', () => {
    expect(
      manifest.peerDependencies.vitest,
      'the peer range is a promise to consumers; an automated bump narrowed it once already',
    ).toBe('^1.6.0 || ^2.0.0 || ^3.0.0 || ^4.0.0 || ^5.0.0')
  })
})
