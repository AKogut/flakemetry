test('records a passing test', () => {
  expect(1 + 1).toBe(2)
})

test('records a second passing test', () => {
  expect('flakemetry').toContain('flake')
})

test('records a failing test', () => {
  expect('sentinel-jest-failure').toBe('not this')
})
