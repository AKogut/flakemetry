import { XMLParser } from 'fast-xml-parser'

import type { TestStatus } from './common'

export interface JunitExecution {
  filePath: string
  suite: string
  title: string
  status: TestStatus
  durationMs: number
  error?: { type?: string | null; message: string; stack?: string | null } | null
}

export interface JunitRun {
  startedAt: string | null
  executions: JunitExecution[]
}

interface XmlNode {
  [key: string]: unknown
}

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  textNodeName: '#text',
})

const asArray = <T>(value: T | T[] | undefined): T[] =>
  value == null ? [] : Array.isArray(value) ? value : [value]

const attr = (node: XmlNode, name: string): string | undefined => {
  const value = node[`@_${name}`]
  return value == null ? undefined : String(value)
}

const textOf = (value: unknown): string => {
  if (value == null) return ''
  if (typeof value === 'string') return value
  if (typeof value === 'object') {
    const node = value as XmlNode
    return node['#text'] == null ? '' : String(node['#text'])
  }
  return String(value)
}

const collectSuites = (doc: XmlNode): XmlNode[] => {
  const root = doc.testsuites as XmlNode | undefined
  if (root) return asArray(root.testsuite as XmlNode | XmlNode[] | undefined)
  return asArray(doc.testsuite as XmlNode | XmlNode[] | undefined)
}

const errorFrom = (
  node: unknown,
  fallbackMessage: string,
): { type: string | null; message: string; stack: string | null } => {
  const object = (typeof node === 'object' && node !== null ? node : {}) as XmlNode
  const text = textOf(node)
  return {
    type: attr(object, 'type') ?? null,
    message: attr(object, 'message') ?? (text.split('\n')[0] || fallbackMessage),
    stack: text || null,
  }
}

const mapCase = (testcase: XmlNode, suiteName: string): JunitExecution => {
  const name = attr(testcase, 'name') ?? 'unknown test'
  const classname = attr(testcase, 'classname') ?? suiteName
  const file = attr(testcase, 'file') ?? classname.replace(/\./g, '/')
  const time = Number(attr(testcase, 'time') ?? '0')
  const durationMs = Number.isFinite(time) ? Math.max(0, Math.round(time * 1000)) : 0

  const base = { filePath: file, suite: classname, title: name, durationMs }

  if (testcase.failure != null) {
    return {
      ...base,
      status: 'fail',
      error: errorFrom(asArray(testcase.failure)[0], 'test failed'),
    }
  }
  if (testcase.error != null) {
    return { ...base, status: 'fail', error: errorFrom(asArray(testcase.error)[0], 'test errored') }
  }
  if (testcase.skipped != null || attr(testcase, 'status') === 'notrun') {
    return { ...base, status: 'skip', error: null }
  }
  return { ...base, status: 'pass', error: null }
}

export const parseJunitXml = (xml: string): JunitRun => {
  const doc = parser.parse(xml) as XmlNode
  const suites = collectSuites(doc)
  const executions: JunitExecution[] = []
  let startedAt: string | null = null

  for (const suite of suites) {
    if (startedAt == null) {
      const timestamp = attr(suite, 'timestamp')
      if (timestamp) startedAt = timestamp
    }
    const suiteName = attr(suite, 'name') ?? ''
    for (const testcase of asArray(suite.testcase as XmlNode | XmlNode[] | undefined)) {
      executions.push(mapCase(testcase, suiteName))
    }
  }

  return { startedAt, executions }
}
