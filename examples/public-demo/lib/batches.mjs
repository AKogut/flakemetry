import {
  junitToIngestBatch,
  parseAllureResults,
  parseJunitXml,
  parseXcresultTests,
} from '@flakemetry/contracts'

const MAX_KEY_LENGTH = 128

export const triggerOf = (event) => {
  if (event === 'schedule') return 'schedule'
  if (event === 'push') return 'push'
  if (event === 'pull_request') return 'pull_request'
  if (event === 'workflow_dispatch') return 'manual'
  return 'other'
}

const resourceOf = (meta, variant) => ({
  ciProvider: 'github_actions',
  ciRunId: String(meta.runId),
  commitSha: meta.sha,
  branch: meta.branch,
  trigger: triggerOf(meta.event),
  variant,
})

const keyOf = (meta, source) => `demo-${meta.slug}-${source}`.slice(0, MAX_KEY_LENGTH)

export const parsedRunBatch = (run, meta, variant, source) => {
  if (run.executions.length === 0) return null
  const batch = junitToIngestBatch(run, {
    idempotencyKey: keyOf(meta, source),
    resource: resourceOf(meta, variant),
    startedAt: new Date(meta.startedAt),
    variant,
  })
  return { ...batch, run: { ...batch.run, finishedAt: null } }
}

export const junitBatch = (xml, meta, variant, source) =>
  parsedRunBatch({ ...parseJunitXml(xml), startedAt: null }, meta, variant, source)

export const ownTestsBatch = (reports, meta, source) =>
  parsedRunBatch(
    {
      startedAt: null,
      executions: reports.flatMap(({ directory, xml }) =>
        parseJunitXml(xml).executions.map((execution) => {
          const filePath = `${directory}/${execution.filePath}`
          return { ...execution, filePath, suite: filePath }
        }),
      ),
    },
    meta,
    undefined,
    source,
  )

export const allureBatch = (results, meta, variant, source) => {
  const run = parseAllureResults(results)
  return parsedRunBatch(
    {
      ...run,
      startedAt: null,
      executions: run.executions.map(({ params: _params, ...execution }) => execution),
    },
    meta,
    variant,
    source,
  )
}

export const xcresultBatch = (tests, meta, variant, source) =>
  parsedRunBatch(parseXcresultTests(tests), meta, variant, source)

export const reporterBatch = (batch, meta, variant, source) => {
  if (batch.executions.length === 0) return null
  return {
    ...batch,
    idempotencyKey: keyOf(meta, source),
    resource: { ...batch.resource, variant },
    executions: batch.executions.map((execution) => ({
      ...execution,
      params: { ...execution.params, variant },
    })),
  }
}

const isIndependentOfTarget = (execution) =>
  execution.filePath.startsWith('tests/unit/') || execution.filePath.startsWith('tests/pact/')

export const withoutTargetIndependentTests = (batch) =>
  batch && {
    ...batch,
    executions: batch.executions.filter((execution) => !isIndependentOfTarget(execution)),
  }

export const restfulReporterBatch = (batch, meta, variant, source) =>
  reporterBatch(
    {
      ...batch,
      executions: batch.executions
        .filter((execution) => !isIndependentOfTarget(execution))
        .map((execution) => ({
          ...execution,
          suite: execution.filePath,
          title: execution.suite ? `${execution.suite} > ${execution.title}` : execution.title,
        })),
    },
    meta,
    variant,
    source,
  )

export const noTestsBatch = (meta, variant, source) => ({
  contractVersion: '0.1.0',
  idempotencyKey: keyOf(meta, source),
  resource: resourceOf(meta, variant),
  run: { status: 'failed', startedAt: new Date(meta.startedAt) },
  executions: [],
})
