import { describe, expect, it } from 'vitest'

import { describeRelatedFailures } from '../related-failures'

const related = (failedInSameRun: boolean) => ({
  testIdentityId: 'id',
  title: 't',
  suite: 's',
  filePath: 'f',
  failedInSameRun,
})

describe('describeRelatedFailures', () => {
  it('claims no shared cause when the failures only share their text', () => {
    const text = describeRelatedFailures({
      sameRunTestCount: 0,
      tests: [related(false), related(false)],
    })

    expect(text).toContain('2 other tests failed with the same error text, in other runs')
    expect(text).not.toContain('root cause')
  })

  it('says likely one root cause when the failures share a run', () => {
    const text = describeRelatedFailures({ sameRunTestCount: 1, tests: [related(true)] })

    expect(text).toBe(
      '1 other test failed with the same error in this run — likely one root cause.',
    )
  })

  it('keeps the tests from other runs out of that claim', () => {
    const text = describeRelatedFailures({
      sameRunTestCount: 1,
      tests: [related(true), related(false)],
    })

    expect(text).toContain('1 other test failed with the same error in this run')
    expect(text).toContain('Others listed here only share the error text')
  })

  it('counts every test in the run, not only the ones the list has room for', () => {
    const text = describeRelatedFailures({
      sameRunTestCount: 40,
      tests: Array.from({ length: 25 }, () => related(true)),
    })

    expect(text).toContain('40 other tests failed with the same error in this run')
    expect(text).not.toContain('Others listed')
  })
})
