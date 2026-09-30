import { expect, test } from 'vitest'

test('records a failing test on the second shard', () => {
  expect('sentinel-vitestshards-failure').toBe('not this')
})
