import { readFileSync } from 'node:fs'

import { describe, expect, it } from 'vitest'

const manifest = JSON.parse(
  readFileSync(new URL('../../package.json', import.meta.url), 'utf8'),
) as { peerDependencies: Record<string, string> }

describe('the Playwright versions this reporter can be installed with', () => {
  it('still admits the oldest Playwright it was verified on', () => {
    expect(
      manifest.peerDependencies['@playwright/test'],
      'the peer range is a promise to consumers; an automated bump narrowed it twice',
    ).toBe('^1.44.0')
  })
})
