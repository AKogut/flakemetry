import { ACTIVE_RCA_PROMPT_VERSION } from '@flakemetry/ai'
import { describe, expect, it } from 'vitest'

import { parseEvalArgs } from '../eval'

const parse = (...argv: string[]) => parseEvalArgs(argv)

describe('parseEvalArgs', () => {
  it('requires a project', () => {
    expect(parse()).toMatchObject({ ok: false, reason: expect.stringContaining('project') })
  })

  it('defaults to the active prompt', () => {
    const parsed = parse('--project', 'p-1')
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) return
    expect(parsed.args.promptVersion).toBe(ACTIVE_RCA_PROMPT_VERSION)
  })

  it('rejects a prompt version that does not exist instead of silently using the active one', () => {
    // Evaluating v3 and reporting it as the active prompt's score would compare two
    // different things and read as movement that never happened.
    expect(parse('--project', 'p-1', '--prompt', 'v99')).toMatchObject({
      ok: false,
      reason: expect.stringContaining('v99'),
    })
  })

  it('refuses a flag whose value was left off rather than eating the next flag', () => {
    expect(parse('--project', '--prompt')).toMatchObject({ ok: false })
  })

  it('reads the baseline paths', () => {
    const parsed = parse('--project', 'p-1', '--baseline', 'a.json', '--write-baseline', 'b.json')
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) return
    expect(parsed.args.baselineFile).toBe('a.json')
    expect(parsed.args.writeBaseline).toBe('b.json')
  })
})
