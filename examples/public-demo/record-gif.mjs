import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

import { chromium } from 'playwright-core'

const [output = 'docs/demo.gif', base = 'https://akogut.github.io/flakemetry/demo/'] =
  process.argv.slice(2)

const SECONDS_PER_FRAME = 4
const WIDTH = 1280
const HEIGHT = 800
const OUTPUT_WIDTH = 1100

const frames = mkdtempSync(join(tmpdir(), 'demo-gif-'))
const browser = await chromium.launch()
const page = await browser.newPage({ viewport: { width: WIDTH, height: HEIGHT } })

const open = (path) => page.goto(new URL(path, base).href, { waitUntil: 'load' })

let index = 0
const frame = async () => {
  index += 1
  await page.screenshot({ path: join(frames, `${String(index).padStart(2, '0')}.png`) })
}

const firstHref = async (selector) => {
  const href = await page.locator(selector).first().getAttribute('href')
  if (!href) throw new Error(`nothing matches ${selector}`)
  return new URL(href, page.url()).href
}

await open('index.html')
await frame()

await page.locator('#one-app-four-runners').evaluate((heading) => heading.scrollIntoView())
await frame()

await open('mobile/flaky.html')
await frame()

await page.goto(await firstHref('a[href*="tests/"]'))
await frame()

await open('restful-booker/runs.html')
for (let hops = 0; hops < 10; hops += 1) {
  if ((await page.getByText('no tests ran').count()) > 0) break
  await page.goto(await firstHref('a[href*="runs-"]'))
}
const noTests = page.getByText('no tests ran').first()
await noTests.evaluate((cell) => cell.scrollIntoView({ block: 'center' }))
await frame()

await open('playwright/flaky.html')
await page.goto(await firstHref('a[href*="tests/"]'))
const trace = await page
  .locator('a[href]')
  .evaluateAll((links) =>
    links.map((link) => link.href).find((href) => /\/tests\/[0-9a-f]+-[0-9a-f]+\.html$/.test(href)),
  )
if (!trace) throw new Error('no test page links to a trace')
await page.goto(trace)
await frame()

await browser.close()

const list = join(frames, 'list.txt')
const names = Array.from({ length: index }, (_, i) => `${String(i + 1).padStart(2, '0')}.png`)
writeFileSync(
  list,
  `${names.map((name) => `file '${join(frames, name)}'\nduration ${SECONDS_PER_FRAME}`).join('\n')}\nfile '${join(frames, names.at(-1))}'\n`,
)

const target = resolve(output)
mkdirSync(resolve(target, '..'), { recursive: true })
execFileSync(
  'ffmpeg',
  [
    '-y',
    '-loglevel',
    'error',
    '-f',
    'concat',
    '-safe',
    '0',
    '-i',
    list,
    '-lavfi',
    `fps=1,scale=${OUTPUT_WIDTH}:-1:flags=lanczos,split[a][b];[a]palettegen=max_colors=128[p];[b][p]paletteuse=dither=none`,
    target,
  ],
  { stdio: 'inherit' },
)
rmSync(frames, { recursive: true, force: true })
process.stdout.write(`wrote ${target} from ${index} frames\n`)
