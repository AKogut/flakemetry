const ANSI = /\x1b\[[0-9;]*m/g
const TIMESTAMP = /^\d{4}-\d\d-\d\dT[\d:.]+Z /

export const cleanLines = (text) =>
  text
    .replace(ANSI, '')
    .split('\n')
    .map((line) => line.replace(TIMESTAMP, '').replace(/\r$/, ''))

const attemptsFrom = (byTest) => {
  const executions = []
  for (const { base, attempts } of byTest.values()) {
    const firstIndex = executions.length
    let failedBefore = false
    attempts.forEach((attempt, index) => {
      const status = attempt.failed ? 'fail' : failedBefore ? 'flaky' : 'pass'
      if (attempt.failed) failedBefore = true
      executions.push({
        ...base,
        status,
        attempt: index + 1,
        retryOfIndex: index > 0 ? firstIndex : null,
        durationMs: attempt.durationMs ?? 0,
        error: attempt.failed
          ? { type: null, message: attempt.message || 'test failed', stack: null }
          : null,
      })
    })
  }
  return executions
}

const XCTEST_RESULT =
  /^Test Case '-\[(\S+)\.(\S+) (\S+)\]' (passed|failed) \((\d+(?:\.\d+)?) seconds\)/
const XCTEST_ERROR = /: error: -\[\S+\.(\S+) (\S+)\] : (.*)$/

export const parseXcuitestLog = (text) => {
  const byTest = new Map()
  const lastError = new Map()
  for (const line of cleanLines(text)) {
    const error = XCTEST_ERROR.exec(line)
    if (error) {
      lastError.set(`${error[1]} ${error[2]}`, error[3])
      continue
    }
    const result = XCTEST_RESULT.exec(line)
    if (!result) continue
    const [, bundle, suite, title, outcome, seconds] = result
    const key = `${suite} ${title}`
    const entry = byTest.get(key) ?? {
      base: { filePath: `${bundle}/${suite}`, suite, title },
      attempts: [],
    }
    entry.attempts.push({
      failed: outcome === 'failed',
      durationMs: Math.round(Number(seconds) * 1000),
      message: lastError.get(key),
    })
    byTest.set(key, entry)
  }
  return attemptsFrom(byTest)
}

const APPIUM_RESULT = /^\[[^\]]*#\d+-\d+\]\s+(✓|✖) (.+?) » \[ \/?(\S+?) \]\s*$/
const APPIUM_ERROR = /^\[[^\]]*\] Error in "(.+)"\s*$/

export const parseAppiumLog = (text, suiteByTitle = new Map()) => {
  const byTest = new Map()
  const lines = cleanLines(text)
  const errors = new Map()
  lines.forEach((line, index) => {
    const error = APPIUM_ERROR.exec(line)
    if (error) errors.set(error[1], (lines[index + 1] ?? '').trim())
  })

  for (const line of lines) {
    const result = APPIUM_RESULT.exec(line)
    if (!result) continue
    const [, mark, title, filePath] = result
    const qualified = [...errors.keys()].find((name) => name.endsWith(`.${title}`))
    const suite =
      suiteByTitle.get(title) ?? (qualified ? qualified.slice(0, -title.length - 1) : '')
    const key = `${filePath} ${title}`
    const entry = byTest.get(key) ?? { base: { filePath, suite, title }, attempts: [] }
    entry.attempts.push({
      failed: mark === '✖',
      message: qualified ? errors.get(qualified)?.replace(/^Error: /, '') : undefined,
    })
    byTest.set(key, entry)
  }
  return attemptsFrom(byTest)
}

const ESPRESSO_FAILURE = /^(\S+) > (\S+?)(?:\[[^\]]*\])? FAILED\s*$/

export const parseEspressoLog = (text) => {
  const failed = new Set()
  let finished = null
  for (const line of cleanLines(text)) {
    const failure = ESPRESSO_FAILURE.exec(line)
    if (failure) failed.add(failure[2])
    const done = /^Finished (\d+) tests on /.exec(line)
    if (done) finished = Number(done[1])
  }
  return { failed, finished }
}

export const espressoExecutions = (universe, failed) =>
  universe.map((test) => ({
    ...test,
    status: failed.has(test.title) ? 'fail' : 'pass',
    attempt: 1,
    retryOfIndex: null,
    error: failed.has(test.title)
      ? { type: null, message: 'failed, per the CI log', stack: null }
      : null,
  }))

export const parseVitestLog = (text) => {
  const lines = cleanLines(text)
  const failed = new Set()
  for (const line of lines) {
    const match = /^\s*FAIL\s+(tests\/\S+ > .*?)\s*$/.exec(line)
    if (match) failed.add(match[1])
  }
  return {
    failed,
    stoppedAtGate: lines.some((line) => line.includes('is not ready after')),
    usedLocalTarget: lines.some((line) => line.includes('failed its health checks')),
  }
}
