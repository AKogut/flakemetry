import { getPrismaClient } from '@flakemetry/db'

const RUNNERS = ['playwright', 'vitest', 'vitest5', 'jest', 'jestshards', 'vitestshards']
const EXPECTED_RUNS = { jestshards: 2, vitestshards: 2 }
const EXPECTED_EXECUTIONS = 3
const TIMEOUT_MS = 120_000
const POLL_MS = 2_000

const prisma = getPrismaClient()

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

const inspect = async (projectId) => {
  const executions = await prisma.testExecution.findMany({
    where: { projectId },
    select: { status: true, errorMessage: true },
  })
  const runs = await prisma.run.count({ where: { projectId } })
  return { runs, executions }
}

const failures = []

for (const runner of RUNNERS) {
  const projectId = process.env[`${runner.toUpperCase()}_PROJECT_ID`]
  if (!projectId) {
    failures.push(`${runner}: no project id in the environment — provisioning did not run`)
    continue
  }

  // The worker processes asynchronously, so absence has to be waited out before it
  // counts as absence.
  const expectedRuns = EXPECTED_RUNS[runner] ?? 1
  const deadline = Date.now() + TIMEOUT_MS
  let state = await inspect(projectId)
  while (
    (state.executions.length < EXPECTED_EXECUTIONS || state.runs < expectedRuns) &&
    Date.now() < deadline
  ) {
    await sleep(POLL_MS)
    state = await inspect(projectId)
  }

  if (state.runs === 0) {
    failures.push(
      `${runner}: no run arrived. The suite ran and passed its own assertions, so the reporter ` +
        `was either never invoked or never delivered — this is the failure mode that shipped ` +
        `broken once already.`,
    )
    continue
  }
  if (state.runs !== expectedRuns) {
    failures.push(
      `${runner}: expected ${expectedRuns} run(s), stored ${state.runs}. Each shard is its own ` +
        `run; a missing one was dropped as a re-delivery of another.`,
    )
    continue
  }
  if (state.executions.length !== EXPECTED_EXECUTIONS) {
    failures.push(
      `${runner}: expected ${EXPECTED_EXECUTIONS} executions, stored ${state.executions.length}`,
    )
    continue
  }

  const failed = state.executions.filter((execution) => execution.status === 'fail')
  if (failed.length !== 1) {
    failures.push(`${runner}: expected exactly one failing execution, stored ${failed.length}`)
    continue
  }
  if (!failed[0]?.errorMessage?.includes(`sentinel-${runner}-failure`)) {
    failures.push(
      `${runner}: the failure arrived without its message — got ${JSON.stringify(failed[0]?.errorMessage)}`,
    )
    continue
  }

  process.stdout.write(
    `${runner}: ${state.runs} run, ${state.executions.length} executions, error text intact\n`,
  )
}

const verifyMatrix = async () => {
  const projectId = process.env.PLAYWRIGHTPROJECTS_PROJECT_ID
  if (!projectId) return ['playwright matrix: no project id in the environment']

  const deadline = Date.now() + TIMEOUT_MS
  let scores = await prisma.flakyScore.findMany({
    where: { projectId },
    include: { identity: { select: { title: true, params: true } } },
  })
  while (scores.length < 6 && Date.now() < deadline) {
    await sleep(POLL_MS)
    scores = await prisma.flakyScore.findMany({
      where: { projectId },
      include: { identity: { select: { title: true, params: true } } },
    })
  }

  const problems = []
  const runs = await prisma.run.count({ where: { projectId } })
  if (runs !== 3) problems.push(`expected a run per job of the matrix, stored ${runs}`)
  if (scores.length !== 6) problems.push(`expected 2 tests on 3 browsers, stored ${scores.length}`)

  const variants = new Set(scores.map((score) => score.identity.params?.variant))
  for (const browser of ['chromium', 'firefox', 'webkit']) {
    if (!variants.has(browser)) problems.push(`no identity carries the variant ${browser}`)
  }

  const onlyWebkit = scores.filter((score) => score.identity.title.includes('webkit only'))
  if (onlyWebkit.some((score) => score.sameShaVariance !== 0)) {
    problems.push('a failure on one browser was read as different results on one commit')
  }
  return problems.map((problem) => `playwright matrix: ${problem}`)
}

failures.push(...(await verifyMatrix()))

await prisma.$disconnect()

if (failures.length > 0) {
  for (const failure of failures) process.stderr.write(`${failure}\n`)
  process.exit(1)
}

process.stdout.write('every reporter delivered\n')
