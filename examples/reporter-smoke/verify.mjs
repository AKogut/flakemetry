import { getPrismaClient } from '@flakemetry/db'

const RUNNERS = ['playwright', 'vitest', 'jest']
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
  const deadline = Date.now() + TIMEOUT_MS
  let state = await inspect(projectId)
  while (state.executions.length < EXPECTED_EXECUTIONS && Date.now() < deadline) {
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

await prisma.$disconnect()

if (failures.length > 0) {
  for (const failure of failures) process.stderr.write(`${failure}\n`)
  process.exit(1)
}

process.stdout.write('every reporter delivered\n')
