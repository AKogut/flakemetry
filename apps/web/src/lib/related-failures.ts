import type { ClusterImpact } from '@flakemetry/queries'

const otherTests = (count: number): string => `${count} other test${count === 1 ? '' : 's'}`

export const describeRelatedFailures = (
  cluster: Pick<ClusterImpact, 'sameRunTestCount' | 'tests'>,
): string => {
  if (cluster.sameRunTestCount === 0) {
    return `${otherTests(cluster.tests.length)} failed with the same error text, in other runs. Matching text alone does not show a shared cause.`
  }

  const inOtherRuns = cluster.tests.some((test) => !test.failedInSameRun)
  return [
    `${otherTests(cluster.sameRunTestCount)} failed with the same error in this run — likely one root cause.`,
    ...(inOtherRuns ? ['Others listed here only share the error text, from other runs.'] : []),
  ].join(' ')
}
