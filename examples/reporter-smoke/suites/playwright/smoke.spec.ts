import { expect, test } from '@playwright/test'

test('records a passing test', () => {
  expect(1 + 1).toBe(2)
})

test('records a second passing test', () => {
  expect('flakemetry').toContain('flake')
})

test('records a failing test', () => {
  // Deliberate. A reporter that delivers only the shape of a run, with statuses or
  // error text lost on the way, is as broken as one that delivers nothing.
  expect('sentinel-playwright-failure').toBe('not this')
})
