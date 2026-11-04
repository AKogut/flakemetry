import { existsSync, globSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { gunzipSync } from 'node:zlib'

import { parseJunitXml } from '@flakemetry/contracts'

import {
  allureBatch,
  junitBatch,
  noTestsBatch,
  parsedRunBatch,
  reporterBatch,
  runStatusOfJob,
  withJobConclusion,
} from './lib/batches.mjs'
import { writeBatch } from './lib/history.mjs'
import {
  espressoExecutions,
  parseAppiumLog,
  parseEspressoLog,
  parseVitestLog,
  parseXcuitestLog,
} from './lib/logs.mjs'
import { nightExecutions, testListFor } from './lib/test-list.mjs'
import { MOBILE_JOBS } from './projects.mjs'

const [archive, history] = process.argv.slice(2)
if (!archive || !history) {
  process.stderr.write('usage: backfill.mjs <archive directory> <history directory>\n')
  process.exit(1)
}

const REPOSITORY = {
  playwright: 'playwright-ecommerce-framework',
  'restful-booker': 'restful-booker-api-testing',
  mobile: 'mobile-task-manager-automation',
}

const readJson = (path) => JSON.parse(readFileSync(path, 'utf8'))
const readLog = (root, jobId) => {
  const path = join(root, 'logs', `${jobId}.log.gz`)
  return existsSync(path) ? gunzipSync(readFileSync(path)).toString('utf8') : null
}

const artifactsOf = (root, prefix) =>
  readdirSync(join(root, 'artifacts'))
    .filter((name) => name.split('__')[2]?.startsWith(prefix))
    .map((name) => {
      const [run, id, artifact] = name.split('__')
      const directory = join(root, 'artifacts', name)
      return {
        run: Number(run),
        id,
        artifact,
        directory,
        meta: readJson(join(directory, '_meta.json')),
      }
    })

const runsOf = (root, workflow) => readJson(join(root, 'runs', `${workflow}.json`))
const jobsOf = (root, runId) => {
  const path = join(root, 'runs', `jobs_${runId}.json`)
  return existsSync(path) ? readJson(path) : []
}
const eventsOf = (root) => {
  const events = new Map()
  for (const name of readdirSync(join(root, 'runs')).filter((file) => !file.startsWith('jobs_'))) {
    for (const run of readJson(join(root, 'runs', name))) events.set(run.databaseId, run.event)
  }
  return events
}

const counts = {}
const save = (slug, batch, source, kind) => {
  if (!batch) return false
  writeBatch(history, slug, batch, source)
  counts[`${slug} ${kind}`] = (counts[`${slug} ${kind}`] ?? 0) + 1
  return true
}

const metaOfArtifact = (slug, artifact, events) => ({
  slug,
  runId: artifact.run,
  sha: artifact.meta.sha,
  branch: artifact.meta.branch,
  event: events.get(artifact.run) ?? 'schedule',
  startedAt: artifact.meta.created,
})

const metaOfRun = (slug, run) => ({
  slug,
  runId: run.databaseId,
  sha: run.headSha,
  branch: run.headBranch,
  event: run.event,
  startedAt: run.createdAt,
})

const backfillPlaywright = () => {
  const slug = 'playwright'
  const root = join(archive, REPOSITORY[slug])
  const events = eventsOf(root)
  for (const artifact of artifactsOf(root, 'flakemetry-')) {
    if (artifact.meta.branch !== 'main') continue
    const browser = artifact.artifact.split('-').at(-1)
    const file = join(artifact.directory, 'run.json')
    if (!existsSync(file)) continue
    save(
      slug,
      reporterBatch(
        readJson(file),
        metaOfArtifact(slug, artifact, events),
        browser,
        `a${artifact.id}`,
      ),
      `a${artifact.id}`,
      'reporter',
    )
  }
}

const backfillRestfulBooker = () => {
  const slug = 'restful-booker'
  const root = join(archive, REPOSITORY[slug])
  const events = eventsOf(root)
  const lists = []

  for (const artifact of artifactsOf(root, 'junit-local-target')) {
    const file = globSync(join(artifact.directory, '*.xml'))[0]
    if (!file) continue
    if (artifact.meta.branch !== 'main') continue
    const xml = readFileSync(file, 'utf8')
    lists.push({
      time: Date.parse(artifact.meta.created),
      tests: parseJunitXml(xml).executions,
    })
    const meta = metaOfArtifact(slug, artifact, events)
    const source = `a${artifact.id}`
    save(slug, junitBatch(xml, meta, 'local', source), source, 'junit local')
  }

  for (const run of runsOf(root, 'Report')) {
    if (run.headBranch !== 'main' || run.conclusion === 'cancelled') continue
    const job = jobsOf(root, run.databaseId)[0]
    const text = job ? readLog(root, job.id) : null
    if (!text) continue
    const log = parseVitestLog(text)
    if (log.usedLocalTarget) continue
    const meta = metaOfRun(slug, run)
    const source = `r${run.databaseId}-live`
    if (log.stoppedAtGate) {
      save(slug, noTestsBatch(meta, 'live', source), source, 'gate, no tests')
      continue
    }
    if (run.conclusion === 'failure' && log.failed.size === 0) continue

    const { tests, problems } = testListFor(lists, Date.parse(run.createdAt), log)
    for (const problem of problems) {
      process.stdout.write(`disagrees ${run.createdAt} r${run.databaseId}: ${problem}\n`)
    }
    if (problems.length > 0) {
      counts[`${slug} live, disagrees with its log`] =
        (counts[`${slug} live, disagrees with its log`] ?? 0) + 1
    }
    save(
      slug,
      withJobConclusion(
        parsedRunBatch(
          { startedAt: null, executions: nightExecutions(tests, log) },
          meta,
          'live',
          source,
        ),
        job.conclusion,
      ),
      source,
      'live, from logs',
    )
  }
}

const backfillMobile = () => {
  const slug = 'mobile'
  const root = join(archive, REPOSITORY[slug])

  const allureByRun = new Map()
  for (const artifact of artifactsOf(root, 'allure-results-')) {
    const platform = artifact.artifact.split('-').at(-1)
    const files = globSync(join(artifact.directory, '**', '*-result.json'))
    if (files.length === 0) continue
    const key = `${artifact.run} appium-${platform}`
    const results = files.map(readJson)
    const previous = allureByRun.get(key)
    if (!previous || results.length > previous.results.length) {
      allureByRun.set(key, { results, artifact })
    }
  }

  const suiteByTitle = new Map()
  for (const { results } of allureByRun.values()) {
    for (const result of results) {
      const suite = result.labels?.find((label) => label.name === 'parentSuite')?.value
      if (result.name && suite) suiteByTitle.set(result.name, suite)
    }
  }

  const junitByRun = new Map()
  const espressoUniverse = new Map()
  for (const artifact of artifactsOf(root, 'espresso-results')) {
    const file = globSync(join(artifact.directory, '**', 'TEST-*.xml'))[0]
    if (!file) continue
    const xml = readFileSync(file, 'utf8')
    junitByRun.set(artifact.run, { xml, artifact })
    for (const execution of parseJunitXml(xml).executions) {
      espressoUniverse.set(execution.title, execution)
    }
  }

  for (const run of runsOf(root, 'Nightly_E2E')) {
    if (run.headBranch !== 'main') continue
    const meta = metaOfRun(slug, run)
    for (const job of jobsOf(root, run.databaseId)) {
      const runner = MOBILE_JOBS.find((candidate) => job.name.startsWith(candidate.match))
      if (!runner || !runStatusOfJob(job.conclusion)) continue
      const variant = runner.variant
      const source = `r${run.databaseId}-${variant}`
      const log = readLog(root, job.id)
      const keep = (batch, kind) =>
        save(slug, withJobConclusion(batch, job.conclusion), source, `${variant} ${kind}`)

      const allure = allureByRun.get(`${run.databaseId} ${variant}`)
      if (allure) {
        keep(allureBatch(allure.results, meta, variant, source), 'allure')
        continue
      }
      const junit = variant === 'espresso' ? junitByRun.get(run.databaseId) : null
      if (junit) {
        keep(junitBatch(junit.xml, meta, variant, source), 'junit')
        continue
      }
      if (!log) continue

      let executions = []
      if (variant === 'xcuitest') executions = parseXcuitestLog(log)
      if (variant.startsWith('appium')) executions = parseAppiumLog(log, suiteByTitle)
      if (variant === 'espresso') {
        const { failed, finished } = parseEspressoLog(log)
        if (finished !== null)
          executions = espressoExecutions([...espressoUniverse.values()], failed)
      }

      if (executions.length > 0) {
        keep(parsedRunBatch({ startedAt: null, executions }, meta, variant, source), 'logs')
      } else if (job.conclusion !== 'success') {
        keep(noTestsBatch(meta, variant, source), 'no tests')
      }
    }
  }
}

backfillPlaywright()
backfillRestfulBooker()
backfillMobile()
for (const [kind, count] of Object.entries(counts).sort()) {
  process.stdout.write(`${String(count).padStart(5)}  ${kind}\n`)
}
