import { readFileSync } from 'node:fs'

const prometheus = (process.env.PROMETHEUS_URL ?? 'http://127.0.0.1:9090').replace(/\/+$/, '')
const dashboard = JSON.parse(
  readFileSync(new URL('./grafana/dashboards/flakemetry.json', import.meta.url), 'utf8'),
)

const RECORDED_BY_ANY_RUN = [
  'flakemetry_http_server_duration_milliseconds_bucket',
  'flakemetry_ingest_runs_accepted_total',
  'flakemetry_ingest_executions_accepted_total',
  'flakemetry_queue_depth',
  'flakemetry_worker_queue_depth',
  'flakemetry_worker_jobs_processed_total',
  'flakemetry_worker_processing_lag_milliseconds_bucket',
  'flakemetry_worker_processing_duration_milliseconds_bucket',
  'flakemetry_worker_time_to_processed_milliseconds_bucket',
]

const get = async (path, params = {}) => {
  const url = new URL(`${prometheus}${path}`)
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value)
  const response = await fetch(url)
  const body = await response.json()
  if (body.status !== 'success') throw new Error(`${path}: ${body.error ?? response.status}`)
  return body.data
}

const problems = []

for (const metric of RECORDED_BY_ANY_RUN) {
  const series = await get('/api/v1/series', { 'match[]': metric })
  if (series.length === 0) problems.push(`no series for ${metric}`)
}

const groups = (await get('/api/v1/rules')).groups
const rules = groups.flatMap((group) => group.rules)
if (rules.length === 0) problems.push('Prometheus has no Flakemetry rules loaded')
for (const rule of rules) {
  if (rule.health !== 'ok') {
    problems.push(`rule ${rule.name} is ${rule.health}: ${rule.lastError ?? 'not evaluated yet'}`)
  }
}

const targets = dashboard.panels.flatMap((panel) =>
  (panel.targets ?? []).map((target) => ({ panel: panel.title, expr: target.expr })),
)
for (const { panel, expr } of targets) {
  try {
    await get('/api/v1/query', { query: expr })
  } catch (error) {
    problems.push(`panel "${panel}" does not run: ${error.message}`)
  }
}

if (problems.length > 0) {
  process.stderr.write(`${problems.join('\n')}\n`)
  process.exit(1)
}
process.stdout.write(
  `${RECORDED_BY_ANY_RUN.length} metrics present, ${rules.length} rules healthy, ${targets.length} panel queries run\n`,
)
