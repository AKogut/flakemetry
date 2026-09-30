import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { POLICY_ENV_VARIABLES } from '@flakemetry/contracts'
import { describe, expect, it } from 'vitest'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..')
const read = (path: string): string => readFileSync(join(root, path), 'utf8')

const VARIABLE = /^\s+(FLAKEMETRY_[A-Z0-9_]+):/

const composeServiceVariables = (source: string): Map<string, Set<string>> => {
  const anchors = new Map<string, Set<string>>()
  const services = new Map<string, Set<string>>()
  let current: Set<string> | null = null
  let inServices = false

  for (const line of source.split('\n')) {
    const topLevel = /^([a-z][\w-]*):(?:\s+&([\w-]+))?\s*$/.exec(line)
    if (topLevel) {
      inServices = topLevel[1] === 'services'
      current = null
      if (topLevel[2]) {
        current = new Set()
        anchors.set(topLevel[2], current)
      }
      continue
    }
    const service = inServices ? /^ {2}([a-z][\w-]*):\s*$/.exec(line) : null
    if (service?.[1]) {
      current = new Set()
      services.set(service[1], current)
      continue
    }
    if (!current) continue
    const merge = /^\s+<<:\s*(.+)$/.exec(line)
    if (merge?.[1]) {
      for (const [, name] of merge[1].matchAll(/\*([\w-]+)/g)) {
        for (const variable of anchors.get(name ?? '') ?? []) current.add(variable)
      }
      continue
    }
    const variable = VARIABLE.exec(line)
    if (variable?.[1]) current.add(variable[1])
  }
  return services
}

const policyVariables = (variables: Iterable<string>): string[] =>
  [...variables].filter((name) => POLICY_ENV_VARIABLES.includes(name)).sort()

describe('the dashboard and the worker resolve policy from the same environment', () => {
  it('knows the policy variables it is checking', () => {
    expect(POLICY_ENV_VARIABLES).toContain('FLAKEMETRY_AI_DAILY_TOKEN_BUDGET')
    expect(POLICY_ENV_VARIABLES.length).toBeGreaterThan(10)
  })

  it.each(['docker-compose.yml', 'deploy/compose/docker-compose.yml'])(
    '%s gives web and worker every policy variable',
    (file) => {
      const services = composeServiceVariables(read(file))
      const worker = services.get('worker')
      const web = services.get('web')
      expect(worker, 'no worker service found').toBeDefined()
      expect(web, 'no web service found').toBeDefined()

      expect(policyVariables(worker ?? [])).toEqual([...POLICY_ENV_VARIABLES].sort())
      expect(policyVariables(web ?? [])).toEqual([...POLICY_ENV_VARIABLES].sort())
    },
  )

  it('the Helm chart gives web the same policy variables as the worker', () => {
    const named = (file: string): string[] =>
      policyVariables(
        [...read(file).matchAll(/name:\s*(FLAKEMETRY_[A-Z0-9_]+)/g)].map((match) => match[1] ?? ''),
      )
    const worker = named('deploy/helm/flakemetry/templates/worker-deployment.yaml')

    expect(worker.length).toBeGreaterThan(0)
    expect(named('deploy/helm/flakemetry/templates/web-deployment.yaml')).toEqual(worker)
  })
})
