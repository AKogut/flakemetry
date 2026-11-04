import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

import { chromium } from 'playwright-core'

const [
  output = 'apps/docs/public/flakemetry-demo.mp4',
  base = 'https://akogut.github.io/flakemetry/demo/',
] = process.argv.slice(2)

const SIZE = { width: 1280, height: 720 }
const directory = mkdtempSync(join(tmpdir(), 'demo-video-'))

const browser = await chromium.launch()
const context = await browser.newContext({
  viewport: SIZE,
  recordVideo: { dir: directory, size: SIZE },
})
const page = await context.newPage()

const showCaption = (text) =>
  page.evaluate((caption) => {
    document.getElementById('demo-caption')?.remove()
    const element = document.createElement('div')
    element.id = 'demo-caption'
    element.textContent = caption
    element.style.cssText = [
      'position:fixed',
      'left:50%',
      'bottom:36px',
      'transform:translateX(-50%)',
      'max-width:1040px',
      'padding:14px 26px',
      'border-radius:12px',
      'background:rgba(9,11,16,.94)',
      'border:1px solid rgba(255,255,255,.18)',
      'color:#fff',
      'font:600 24px/1.35 system-ui,sans-serif',
      'text-align:center',
      'z-index:9999',
      'box-shadow:0 12px 40px rgba(0,0,0,.6)',
    ].join(';')
    document.body.append(element)
  }, text)

const scrollBy = (distance, milliseconds) =>
  page.evaluate(
    ([pixels, duration]) =>
      new Promise((done) => {
        const start = performance.now()
        const from = window.scrollY
        const step = (now) => {
          const progress = Math.min(1, (now - start) / duration)
          window.scrollTo(0, from + pixels * progress)
          if (progress < 1) requestAnimationFrame(step)
          else done()
        }
        requestAnimationFrame(step)
      }),
    [distance, milliseconds],
  )

const open = (path) => page.goto(new URL(path, base).href, { waitUntil: 'load' })

const firstHref = async (selector) => {
  const href = await page.locator(selector).first().getAttribute('href')
  if (!href) throw new Error(`nothing matches ${selector}`)
  return new URL(href, page.url()).href
}

const beat = async (caption, seconds, scroll = 0) => {
  await showCaption(caption)
  await page.waitForTimeout(1200)
  if (scroll) await scrollBy(scroll, (seconds - 2.4) * 1000)
  else await page.waitForTimeout((seconds - 2.4) * 1000)
  await page.waitForTimeout(1200)
}

await open('index.html')
await beat(
  'Flakemetry on real test suites. Nothing is seeded, and it is rebuilt every night.',
  9,
  120,
)

await page.locator('#one-app-four-runners').evaluate((heading) => heading.scrollIntoView())
await beat('One app, four runners. A green job does not mean a test passed first time.', 11, 260)

await open('mobile/flaky.html')
await beat(
  'Every test ranked by how much it erodes trust, with the signals behind each score.',
  9,
  200,
)

await page.goto(await firstHref('a[href*="tests/"]'))
await beat(
  'One test: when it started failing, its history, why it scored that way, each platform apart.',
  11,
  320,
)

await open('restful-booker/runs.html')
for (let hops = 0; hops < 10; hops += 1) {
  if ((await page.getByText('no tests ran').count()) > 0) break
  await page.goto(await firstHref('a[href*="runs-"]'))
}
await page
  .getByText('no tests ran')
  .first()
  .evaluate((cell) => cell.scrollIntoView({ block: 'center' }))
await beat('The platform under test went down. These runs say so, and no test is blamed for it.', 9)

await open('playwright/flaky.html')
await page.goto(await firstHref('a[href*="tests/"]'))
const trace = await page
  .locator('a[href]')
  .evaluateAll((links) =>
    links.map((link) => link.href).find((href) => /\/tests\/[0-9a-f]+-[0-9a-f]+\.html$/.test(href)),
  )
if (!trace) throw new Error('no test page links to a trace')
await page.goto(trace)
await beat('Every test is a trace, not a line in a report.', 7)

await open('index.html')
await beat('Open source and self-hosted: github.com/AKogut/flakemetry', 5)

await context.close()
await browser.close()

const recorded = readdirSync(directory).find((name) => name.endsWith('.webm'))
if (!recorded) throw new Error('no video was recorded')

const target = resolve(output)
mkdirSync(resolve(target, '..'), { recursive: true })
execFileSync(
  'ffmpeg',
  [
    '-y',
    '-loglevel',
    'error',
    '-i',
    join(directory, recorded),
    '-c:v',
    'libx264',
    '-crf',
    '30',
    '-preset',
    'slow',
    '-pix_fmt',
    'yuv420p',
    '-movflags',
    '+faststart',
    '-an',
    target,
  ],
  { stdio: 'inherit' },
)
rmSync(directory, { recursive: true, force: true })
process.stdout.write(`wrote ${target}\n`)
