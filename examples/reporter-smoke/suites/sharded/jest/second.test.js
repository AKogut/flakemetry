test('records a failing test on the second shard', () => {
  expect('sentinel-jestshards-failure').toBe('not this')
})
