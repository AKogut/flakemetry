import { expect, test } from 'vitest'

test('records a passing test on the first shard', () => {
  expect(1 + 1).toBe(2)
})

test('records a second passing test on the first shard', () => {
  expect('flakemetry').toContain('flake')
})
