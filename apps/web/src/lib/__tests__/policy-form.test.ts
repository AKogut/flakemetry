import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { POLICY_FIELDS } from '@flakemetry/contracts'
import { describe, expect, it } from 'vitest'

const web = resolve(dirname(fileURLToPath(import.meta.url)), '../../..')
const read = (path: string): string => readFileSync(join(web, path), 'utf8')

const actions = read('src/lib/actions.ts')
const page = read('src/app/projects/[projectId]/settings/policy/page.tsx')

const policyAction = actions.slice(
  actions.indexOf('export const updateProjectPolicy'),
  actions.indexOf('persistProjectPolicy(prisma'),
)

const fieldsTheActionReads = [
  ...policyAction.matchAll(/(?:numberField|tristateField)\(formData, '([A-Za-z]+)'/g),
].map((match) => match[1] ?? '')

const inputsOnThePage = new Set(
  [...page.matchAll(/name="([A-Za-z]+)"/g)].map((match) => match[1] ?? ''),
)

describe('the policy form', () => {
  it('reads the fields it is meant to be checking', () => {
    expect(fieldsTheActionReads.length).toBeGreaterThan(10)
    expect(
      fieldsTheActionReads.every((field) => (POLICY_FIELDS as readonly string[]).includes(field)),
    ).toBe(true)
  })

  it('has an input for every field the save action reads', () => {
    const missing = fieldsTheActionReads.filter((field) => !inputsOnThePage.has(field))

    expect(
      missing,
      'the action stores null for a field with no input, clearing it on every save',
    ).toEqual([])
  })
})
