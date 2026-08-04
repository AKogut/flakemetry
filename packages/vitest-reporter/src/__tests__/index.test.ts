import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import FlakemetryVitestReporter from '../index'
import type { VitestFile } from '../mapping'

const sampleFile = (): VitestFile => ({
  type: 'suite',
  name: 'checkout.test.ts',
  filepath: '/repo/tests/checkout.test.ts',
  tasks: [
    {
      type: 'test',
      name: 'renders the total',
      result: { state: 'pass', duration: 12 },
    },
  ],
})

const withEnv = (reporter: FlakemetryVitestReporter): FlakemetryVitestReporter => {
  Object.assign(reporter as unknown as Record<string, unknown>, {
    env: { FLAKEMETRY_PROJECT: 'demo/web', FLAKEMETRY_COMMIT_SHA: 'abc1234' },
  })
  return reporter
}

describe('the hook Vitest actually calls', () => {
  it('implements onTestRunEnd, which is how Vitest 4 reports', () => {
    // Vitest 4 dropped onFinished. Implementing only that made the reporter deliver
    // nothing at all: the suite passed, no data arrived, and nothing said so — while
    // the package declared `vitest: ^4` as a peer.
    const reporter = new FlakemetryVitestReporter()
    expect(typeof (reporter as unknown as Record<string, unknown>).onTestRunEnd).toBe('function')
  })

  it('still implements onFinished, so a Vitest 3 consumer keeps working', () => {
    const reporter = new FlakemetryVitestReporter()
    expect(typeof (reporter as unknown as Record<string, unknown>).onFinished).toBe('function')
  })

  it('produces the same batch from either hook', async () => {
    const modern = join(tmpdir(), `flakemetry-${randomUUID()}.json`)
    const legacy = join(tmpdir(), `flakemetry-${randomUUID()}.json`)

    await (
      withEnv(new FlakemetryVitestReporter({ outputFile: modern })) as unknown as {
        onTestRunEnd: (modules: unknown[]) => Promise<void>
      }
    ).onTestRunEnd([{ task: sampleFile() }])

    await (
      withEnv(new FlakemetryVitestReporter({ outputFile: legacy })) as unknown as {
        onFinished: (files: VitestFile[]) => Promise<void>
      }
    ).onFinished([sampleFile()])

    // Timestamps are taken when the report is written, so only the mapped identity of
    // each test is comparable — which is the part that must not differ by hook.
    const identify = (path: string) =>
      (
        JSON.parse(readFileSync(path, 'utf8')) as {
          executions: { filePath: string; suite: string; title: string; status: string }[]
        }
      ).executions.map(({ filePath, suite, title, status }) => ({
        filePath,
        suite,
        title,
        status,
      }))

    expect(identify(modern).length).toBeGreaterThan(0)
    expect(identify(modern)).toEqual(identify(legacy))
  })
})
