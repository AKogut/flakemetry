import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

const APP = join(__dirname, '..', '..', 'app')
const PROJECT = join(APP, 'projects', '[projectId]')

const filesUnder = (directory: string): string[] =>
  readdirSync(directory).flatMap((entry) => {
    const full = join(directory, entry)
    return statSync(full).isDirectory()
      ? filesUnder(full)
      : /\.tsx?$/.test(entry) && !full.includes('__tests__')
        ? [full]
        : []
  })

const PUBLIC_PAGES = [
  'runs/page.tsx',
  'flaky/page.tsx',
  'suite-health/page.tsx',
  'health/page.tsx',
  'cost/page.tsx',
  'test-cases/page.tsx',
  'tests/[testId]/page.tsx',
  'tests/[testId]/executions/[executionId]/page.tsx',
].map((page) => join(PROJECT, page))

const source = (path: string): string => readFileSync(path, 'utf8')

describe('what a visitor can reach', () => {
  it('is exactly the read pages, so a new page stays private until someone decides otherwise', () => {
    const opened = filesUnder(APP).filter((file) => source(file).includes('requireProjectViewer'))
    const expected = [...PUBLIC_PAGES, join(PROJECT, 'layout.tsx')]
    expect(opened.sort()).toEqual(expected.sort())
  })

  it('never includes a settings page or the export', () => {
    for (const file of filesUnder(join(PROJECT, 'settings'))) {
      const text = source(file)
      expect(text, file).not.toContain('requireProjectViewer')
      expect(text, file).toContain('requireUser')
    }
  })

  it('never includes a server action', () => {
    const actions = source(join(__dirname, '..', 'actions.ts'))
    expect(actions).not.toContain('requireProjectViewer')
    expect(actions).not.toContain('resolveProjectViewer')
  })

  it('renders no form on a read page outside the test page, where controls are guarded', () => {
    for (const page of PUBLIC_PAGES.filter((file) => !file.endsWith('[testId]/page.tsx'))) {
      expect(source(page), page).not.toMatch(/<form|action=\{/)
    }
  })
})
