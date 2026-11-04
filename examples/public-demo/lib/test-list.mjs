import { isIndependentOfTarget } from './batches.mjs'

const keyOf = (test) => `${test.suite} > ${test.title}`
const fileOfKey = (key) => key.split(' > ')[0]

const errorOf = (message) => (message ? { type: null, message, stack: null } : null)

const fileTotals = (tests) => {
  const totals = new Map()
  for (const test of tests) totals.set(test.filePath, (totals.get(test.filePath) ?? 0) + 1)
  return totals
}

const countsByFile = (keys) => {
  const counts = new Map()
  for (const key of keys) {
    const file = fileOfKey(key)
    counts.set(file, (counts.get(file) ?? 0) + 1)
  }
  return counts
}

export const disagreements = (tests, log) => {
  const problems = []
  const dependent = [...log.files].filter(([file]) => !isIndependentOfTarget({ filePath: file }))
  const listed = fileTotals(tests)
  const logged = new Map(dependent.map(([file, { total }]) => [file, total]))
  for (const file of new Set([...listed.keys(), ...logged.keys()])) {
    const inList = listed.get(file) ?? 0
    const inLog = logged.get(file) ?? 0
    if (inList !== inLog) problems.push(`${file}: ${inLog} in the log, ${inList} in the list`)
  }

  const inFiles = [...log.files.values()].reduce((sum, { total }) => sum + total, 0)
  if (log.total !== inFiles) {
    problems.push(`the log counts ${log.total} tests but its files add up to ${inFiles}`)
  }

  const failedByFile = countsByFile(log.failed.keys())
  const skippedByFile = countsByFile(log.skipped)
  for (const [file, { failed, skipped }] of dependent) {
    const named = failedByFile.get(file) ?? 0
    const namedSkips = skippedByFile.get(file) ?? 0
    if (failed !== named) problems.push(`${file}: ${failed} failed, ${named} named as failed`)
    if (skipped !== namedSkips) {
      problems.push(`${file}: ${skipped} skipped, ${namedSkips} named as skipped`)
    }
  }

  const known = new Set(tests.map(keyOf))
  for (const key of new Set([...log.named, ...log.failed.keys()])) {
    if (!known.has(key) && !isIndependentOfTarget({ filePath: fileOfKey(key) })) {
      problems.push(`named in the log, not in the list: ${key}`)
    }
  }
  return problems
}

const byNearestEarlierFirst = (lists, time) => {
  const earlier = lists.filter((list) => list.time <= time).sort((a, b) => b.time - a.time)
  const later = lists.filter((list) => list.time > time).sort((a, b) => a.time - b.time)
  return [...earlier, ...later]
}

export const testListFor = (lists, time, log) => {
  const candidates = byNearestEarlierFirst(lists, time)
  const chosen =
    candidates.find((list) => disagreements(list.tests, log).length === 0) ?? candidates[0]
  return { tests: chosen?.tests ?? [], problems: chosen ? disagreements(chosen.tests, log) : [] }
}

export const nightExecutions = (tests, { failed, skipped }) => {
  const known = new Set(tests.map(keyOf))
  const statusOf = (key) => (failed.has(key) ? 'fail' : skipped.has(key) ? 'skip' : 'pass')
  const listed = tests.map((test) => ({
    ...test,
    status: statusOf(keyOf(test)),
    attempt: 1,
    retryOfIndex: null,
    durationMs: 0,
    error: errorOf(failed.get(keyOf(test))),
  }))
  const unlisted = [...failed.keys()]
    .filter((key) => !known.has(key))
    .map((key) => {
      const [filePath, ...rest] = key.split(' > ')
      return {
        filePath,
        suite: filePath,
        title: rest.join(' > '),
        status: 'fail',
        attempt: 1,
        retryOfIndex: null,
        durationMs: 0,
        error: errorOf(failed.get(key)),
      }
    })
  return [...listed, ...unlisted]
}
