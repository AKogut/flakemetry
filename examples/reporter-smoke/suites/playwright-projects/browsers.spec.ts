import { expect, test } from '@playwright/test'

test('passes on every browser', () => {
  expect(1 + 1).toBe(2)
})

test('fails on webkit only', ({}, testInfo) => {
  expect(testInfo.project.name).not.toBe('webkit')
})
