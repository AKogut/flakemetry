import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

import { getPrismaClient } from '@flakemetry/db'
import * as cheerio from 'cheerio'

import { renderOverview } from './lib/overview.mjs'
import { pageFileFor, relativeLink } from './lib/site.mjs'

const [provisionedFile, output] = process.argv.slice(2)
if (!provisionedFile || !output) {
  process.stderr.write('usage: snapshot.mjs <provisioned.json> <output directory>\n')
  process.exit(1)
}

const web = (process.env.DEMO_WEB_URL ?? 'http://localhost:3000').replace(/\/+$/, '')
const api = (process.env.FLAKEMETRY_ENDPOINT ?? 'http://localhost:4000').replace(/\/+$/, '')
const prisma = getPrismaClient()
const projects = JSON.parse(readFileSync(provisionedFile, 'utf8'))

const STYLESHEET = 'assets/style.css'
const MAX_RUN_PAGES = 8
const MAX_TRACES_PER_TEST = 2
const CONCURRENCY = 8

rmSync(output, { recursive: true, force: true })
mkdirSync(join(output, 'assets'), { recursive: true })

const stylesheets = new Map()
const collectStylesheets = async ($) => {
  for (const element of $('link[rel="stylesheet"]').toArray()) {
    const href = $(element).attr('href')
    if (href && !stylesheets.has(href)) {
      const response = await fetch(`${web}${href}`)
      if (!response.ok) throw new Error(`stylesheet ${href}: ${response.status}`)
      stylesheets.set(href, await response.text())
    }
  }
}

const snapshotProject = async (project) => {
  const base = `/projects/${project.projectId}`
  const identities = await prisma.testIdentity.findMany({
    where: { projectId: project.projectId },
    select: { id: true, fingerprint: true },
  })
  const fingerprintById = new Map(
    identities.map((row) => [row.id, row.fingerprint.replace('sha256:', '').slice(0, 16)]),
  )

  const queued = new Map()
  const fileOf = (url) => pageFileFor(url, base, project.slug, fingerprintById)
  const enqueue = (pathAndQuery) => {
    const url = new URL(pathAndQuery, web)
    const file = fileOf(url)
    if (file && !queued.has(file)) queued.set(file, url.pathname + url.search)
    return file
  }
  for (const page of ['runs', 'flaky', 'suite-health', 'health', 'cost']) enqueue(`${base}/${page}`)

  const done = new Set()
  let runPages = 0
  const tracesByTest = new Map()

  const allowed = (url) => {
    const rest = url.pathname.slice(base.length + 1)
    if (rest === 'runs' && url.searchParams.has('cursor')) {
      if (!queued.has(fileOf(url))) {
        if (runPages >= MAX_RUN_PAGES) return false
        runPages += 1
      }
      return true
    }
    const trace = /^tests\/([0-9a-f-]{36})\/executions\//.exec(rest)
    if (trace && !queued.has(fileOf(url))) {
      const seen = tracesByTest.get(trace[1]) ?? 0
      if (seen >= MAX_TRACES_PER_TEST) return false
      tracesByTest.set(trace[1], seen + 1)
    }
    return true
  }

  const renderPage = async (file, path) => {
    const response = await fetch(`${web}${path}`, { redirect: 'manual' })
    if (response.status !== 200) throw new Error(`${path}: answered ${response.status}`)
    const $ = cheerio.load(await response.text())
    await collectStylesheets($)

    $('script, link[as="script"], link[rel="preload"], meta[name="next-size-adjust"]').remove()
    $('link[rel="stylesheet"]').remove()
    $('head').append(`<link rel="stylesheet" href="${relativeLink(file, STYLESHEET)}">`)

    for (const element of $('a[href]').toArray()) {
      const link = $(element)
      const href = link.attr('href')
      if (/^https?:\/\//.test(href) && !href.startsWith(web)) continue
      const url = new URL(href, `${web}${path}`)
      const target = allowed(url) ? fileOf(url) : null
      if (!target) {
        link.replaceWith(`<span>${link.html() ?? ''}</span>`)
        continue
      }
      enqueue(url.pathname + url.search)
      link.attr('href', relativeLink(file, target))
    }

    for (const element of $('*').toArray()) {
      const node = $(element)
      if (node.children().length === 0 && node.text().trim().startsWith('Select a span')) {
        node.text('This is a static snapshot. A running instance shows the details of a span here.')
      }
    }

    const home = relativeLink(file, 'index.html')
    $('.brand').wrapInner(`<a href="${home}" style="color:inherit;text-decoration:none"></a>`)
    $('.nav').prepend(`<a href="${home}">All projects</a>`)
    $('.user').html(
      `<div class="muted">Snapshot of real CI results, rebuilt nightly.</div><a href="${project.repository ?? `https://github.com/${project.repo}`}">Source repository</a>`,
    )
    $('title').text(`${$('.page-title').first().text().trim() || project.name} · Flakemetry demo`)

    const target = join(output, file)
    mkdirSync(dirname(target), { recursive: true })
    writeFileSync(target, $.html())
    done.add(file)
  }

  while (done.size < queued.size) {
    const pending = [...queued.entries()].filter(([file]) => !done.has(file))
    for (let index = 0; index < pending.length; index += CONCURRENCY) {
      await Promise.all(
        pending.slice(index, index + CONCURRENCY).map(([file, path]) => renderPage(file, path)),
      )
    }
  }

  const badge = await fetch(`${api}/badge/${project.badgeToken}/health.json`)
  if (!badge.ok) throw new Error(`badge for ${project.slug}: ${badge.status}`)
  writeFileSync(join(output, project.slug, 'health.json'), await badge.text())

  process.stdout.write(`${project.slug}: ${done.size} page(s)\n`)
}

for (const project of projects) await snapshotProject(project)

const css = [...stylesheets.values()].join('\n')
if (/url\(\/_next\//.test(css)) {
  process.stderr.write('warning: the stylesheet refers to a file under /_next/\n')
}
const extra = readFileSync(new URL('./lib/overview.css', import.meta.url), 'utf8')
writeFileSync(join(output, STYLESHEET), `${css}\n${extra}`)
writeFileSync(join(output, 'index.html'), await renderOverview(prisma, projects))
await prisma.$disconnect()

const problems = []
const walk = async () => {
  const { globSync } = await import('node:fs')
  return globSync('**/*.html', { cwd: output })
}
const pages = await walk()
for (const page of pages) {
  const html = readFileSync(join(output, page), 'utf8')
  if (/<script\b/i.test(html)) problems.push(`${page}: has a script`)
  if (/<form\b/i.test(html)) problems.push(`${page}: has a form`)
  if (/fmk_[a-z0-9]{8,}/i.test(html)) problems.push(`${page}: has something like an ingest token`)
  if (/bdg_[a-z0-9]{8,}/i.test(html)) problems.push(`${page}: has a badge token`)
  if (html.includes(web) || /\/sign-in/.test(html)) problems.push(`${page}: points at the app`)
  const $ = cheerio.load(html)
  for (const element of $('a[href]').toArray()) {
    const href = $(element).attr('href')
    if (/^https?:\/\//.test(href) || href.startsWith('#')) continue
    const resolved = join(dirname(join(output, page)), href.split('#')[0])
    if (!existsSync(resolved)) problems.push(`${page}: broken link ${href}`)
  }
}

if (problems.length > 0) {
  for (const problem of problems.slice(0, 40)) process.stderr.write(`${problem}\n`)
  process.stderr.write(`${problems.length} problem(s) in the snapshot\n`)
  process.exit(1)
}
process.stdout.write(`snapshot of ${pages.length} page(s) is clean\n`)
