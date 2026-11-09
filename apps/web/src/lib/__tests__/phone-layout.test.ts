import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

const APP = join(__dirname, '..', '..', 'app')
const css = readFileSync(join(APP, 'globals.css'), 'utf8')

const pagesUnder = (directory: string): string[] =>
  readdirSync(directory).flatMap((entry) => {
    const full = join(directory, entry)
    if (statSync(full).isDirectory()) return pagesUnder(full)
    return entry === 'page.tsx' ? [full] : []
  })

const stackedTables = pagesUnder(APP).flatMap((page) =>
  [
    ...readFileSync(page, 'utf8').matchAll(
      /<table className="table-stack[^"]*">[\s\S]*?<\/table>/g,
    ),
  ].map(([table]) => ({ page, table })),
)

const withoutPhoneRules = css.replace(/@media \(max-width: [\d.]+px\) \{[\s\S]*?\n\}\n?/g, '')

describe('the dashboard on a phone', () => {
  it('stacks the wide tables', () => {
    expect(stackedTables.map(({ page }) => page.split('[projectId]/')[1]).sort()).toEqual([
      'cost/page.tsx',
      'flaky/page.tsx',
      'runs/page.tsx',
      'suite-health/page.tsx',
      'test-cases/page.tsx',
      'tests/[testId]/page.tsx',
    ])
  })

  it('labels a stacked cell with the heading of its own column', () => {
    for (const { table } of stackedTables) {
      const headings = [...table.matchAll(/<th\b[^>]*>([^<{]+)<\/th>/g)].map(([, text]) =>
        text!.trim(),
      )
      const labels = [...table.matchAll(/data-label="([^"]+)"/g)].map(([, label]) => label)
      for (const label of labels) expect(headings).toContain(label)
    }
  })

  it('keeps every phone rule out of the desktop layout', () => {
    for (const name of ['table-stack', 'stack-main', 'stack-optional', 'sidebar-project']) {
      expect(css).toContain(name)
      expect(withoutPhoneRules).not.toContain(name)
    }
    expect(withoutPhoneRules).toMatch(/\.sidebar \{\s+width: 232px;/)
    expect(withoutPhoneRules).toMatch(
      /\.main \{\s+flex: 1;\s+padding: 1\.75rem 2rem;\s+max-width: 1100px;/,
    )
  })

  it('never hides sideways overflow on the page itself', () => {
    expect(css).not.toMatch(/(html|body)[^{}]*\{[^}]*overflow(-x)?: hidden/)
  })
})
