import { execFileSync } from 'node:child_process'
import { globSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, relative } from 'node:path'

import {
  allureBatch,
  junitBatch,
  noTestsBatch,
  ownTestsBatch,
  reporterBatch,
  restfulReporterBatch,
  withJobConclusion,
  withoutTargetIndependentTests,
  xcresultBatch,
} from './lib/batches.mjs'
import { knownSources, writeBatch } from './lib/history.mjs'
import { MOBILE_JOBS, PROJECTS } from './projects.mjs'

const [history] = process.argv.slice(2)
if (!history) {
  process.stderr.write('usage: collect.mjs <history directory>\n')
  process.exit(1)
}

const LOOKBACK_RUNS = 30
const MAX_ARTIFACT_PAGES = 5
const MAX_BUFFER = 512 * 1024 * 1024

const api = (path) =>
  JSON.parse(execFileSync('gh', ['api', path], { encoding: 'utf8', maxBuffer: MAX_BUFFER }))

const downloadArtifact = (artifact) => {
  const directory = mkdtempSync(join(tmpdir(), 'demo-artifact-'))
  const archive = join(directory, 'artifact.zip')
  writeFileSync(
    archive,
    execFileSync('gh', ['api', artifact.archive_download_url], { maxBuffer: MAX_BUFFER }),
  )
  execFileSync('unzip', ['-q', '-o', archive, '-d', directory])
  return directory
}

const readJson = (path) => JSON.parse(readFileSync(path, 'utf8'))

const COLLECTORS = {
  flakemetry: [
    {
      match: /^own-test-results$/,
      source: (artifact) => `r${artifact.workflow_run.id}`,
      variant: () => undefined,
      build: (directory, meta, _variant, source) =>
        ownTestsBatch(
          globSync(join(directory, '**', 'junit.xml')).map((file) => ({
            directory: relative(directory, dirname(file)),
            xml: readFileSync(file, 'utf8'),
          })),
          meta,
          source,
        ),
    },
  ],
  playwright: [
    {
      match: /^flakemetry-\w+-(chromium|firefox|webkit)$/,
      source: (artifact) => `a${artifact.id}`,
      variant: (match) => match[1],
      build: (directory, meta, variant, source) => {
        const file = globSync(join(directory, '**', 'run.json'))[0]
        return file ? reporterBatch(readJson(file), meta, variant, source) : null
      },
    },
  ],
  'restful-booker': [
    {
      match: /^junit-local-target$/,
      source: (artifact) => `a${artifact.id}`,
      variant: () => 'local',
      build: (directory, meta, variant, source) => {
        const file = globSync(join(directory, '**', '*.xml'))[0]
        return file ? junitBatch(readFileSync(file, 'utf8'), meta, variant, source) : null
      },
    },
    {
      match: /^junit-report-(live|local)-\d+$/,
      source: (artifact, match) => `r${artifact.workflow_run.id}-${match[1]}`,
      variant: (match) => match[1],
      build: (directory, meta, variant, source) => {
        const recorded = globSync(join(directory, '**', 'flakemetry-run.json'))[0]
        if (recorded) return restfulReporterBatch(readJson(recorded), meta, variant, source)
        const file = globSync(join(directory, '**', '*.xml'))[0]
        return file
          ? withoutTargetIndependentTests(
              junitBatch(readFileSync(file, 'utf8'), meta, variant, source),
            )
          : null
      },
    },
  ],
  mobile: [
    {
      match: /^allure-results-(android|ios)$/,
      source: (artifact, match) => `r${artifact.workflow_run.id}-appium-${match[1]}`,
      variant: (match) => `appium-${match[1]}`,
      build: (directory, meta, variant, source) =>
        allureBatch(
          globSync(join(directory, '**', '*-result.json')).map(readJson),
          meta,
          variant,
          source,
        ),
    },
    {
      match: /^espresso-results$/,
      source: (artifact) => `r${artifact.workflow_run.id}-espresso`,
      variant: () => 'espresso',
      build: (directory, meta, variant, source) => {
        const file = globSync(join(directory, '**', 'TEST-*.xml'))[0]
        return file ? junitBatch(readFileSync(file, 'utf8'), meta, variant, source) : null
      },
    },
    {
      match: /^xcuitest-results$/,
      source: (artifact) => `r${artifact.workflow_run.id}-xcuitest`,
      variant: () => 'xcuitest',
      build: (directory, meta, variant, source) => {
        const file = globSync(join(directory, '**', 'xcuitest-tests.json'))[0]
        return file ? xcresultBatch(readJson(file), meta, variant, source) : null
      },
    },
  ],
}

const NO_TEST_RUNS = {
  'restful-booker': {
    workflow: 'report.yml',
    variantOf: (job) => (job.name.startsWith('Test and publish') ? 'live' : null),
    alreadyHas: (known, runId) => known.has(`r${runId}-live`) || known.has(`r${runId}-local`),
  },
  mobile: {
    workflow: 'nightly-e2e.yml',
    variantOf: (job) =>
      MOBILE_JOBS.find((candidate) => job.name.startsWith(candidate.match))?.variant ?? null,
    alreadyHas: (known, runId, variant) => known.has(`r${runId}-${variant}`),
  },
}

const metaFrom = (slug, run) => ({
  slug,
  runId: run.id,
  sha: run.head_sha,
  branch: run.head_branch,
  event: run.event,
  startedAt: run.created_at,
})

let collected = 0
let failed = 0

const collectArtifacts = (project, known) => {
  const collectors = COLLECTORS[project.slug]
  const rule = NO_TEST_RUNS[project.slug]
  const runs = new Map()
  const jobs = new Map()
  const jobsOf = (runId) => {
    if (!jobs.has(runId)) {
      jobs.set(runId, api(`repos/${project.repo}/actions/runs/${runId}/jobs?per_page=50`).jobs)
    }
    return jobs.get(runId)
  }
  for (let page = 1; page <= MAX_ARTIFACT_PAGES; page += 1) {
    const { artifacts } = api(`repos/${project.repo}/actions/artifacts?per_page=100&page=${page}`)
    for (const artifact of artifacts) {
      if (artifact.expired || artifact.workflow_run?.head_branch !== 'main') continue
      for (const collector of collectors) {
        const match = collector.match.exec(artifact.name)
        if (!match) continue
        const source = collector.source(artifact, match)
        if (known.has(source)) continue
        known.add(source)
        let directory
        try {
          const runId = artifact.workflow_run.id
          if (!runs.has(runId)) runs.set(runId, api(`repos/${project.repo}/actions/runs/${runId}`))
          directory = downloadArtifact(artifact)
          const meta = metaFrom(project.slug, runs.get(runId))
          const variant = collector.variant(match)
          const batch = collector.build(directory, meta, variant, source)
          if (batch) {
            const conclusion = rule
              ? jobsOf(runId).find((job) => rule.variantOf(job) === variant)?.conclusion
              : undefined
            writeBatch(history, project.slug, withJobConclusion(batch, conclusion), source)
            collected += 1
          }
        } catch (error) {
          known.delete(source)
          failed += 1
          process.stderr.write(`${project.slug} ${artifact.name}: ${error.message}\n`)
        } finally {
          if (directory) rmSync(directory, { recursive: true, force: true })
        }
      }
    }
    if (artifacts.length < 100) break
  }
}

const collectRunsWithoutTests = (project, known) => {
  const rule = NO_TEST_RUNS[project.slug]
  if (!rule) return
  const { workflow_runs: runs } = api(
    `repos/${project.repo}/actions/workflows/${rule.workflow}/runs?branch=main&status=completed&per_page=${LOOKBACK_RUNS}`,
  )
  for (const run of runs) {
    const { jobs } = api(`repos/${project.repo}/actions/runs/${run.id}/jobs?per_page=50`)
    for (const job of jobs) {
      const variant = rule.variantOf(job)
      if (!variant || !['failure', 'cancelled'].includes(job.conclusion)) continue
      if (rule.alreadyHas(known, run.id, variant)) continue
      const source = `r${run.id}-${variant}`
      writeBatch(
        history,
        project.slug,
        withJobConclusion(
          noTestsBatch(metaFrom(project.slug, run), variant, source),
          job.conclusion,
        ),
        source,
      )
      known.add(source)
      collected += 1
    }
  }
}

for (const project of PROJECTS) {
  const known = knownSources(history, project.slug)
  try {
    collectArtifacts(project, known)
    collectRunsWithoutTests(project, known)
  } catch (error) {
    failed += 1
    process.stderr.write(`${project.slug}: ${error.message}\n`)
  }
}

process.stdout.write(`collected ${collected} new run(s), ${failed} could not be read\n`)
