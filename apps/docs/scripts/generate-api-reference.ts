import { writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const AUTH_LABELS: Record<string, string> = {
  none: 'none',
  'ingest-token': 'project token with the `ingest` scope (`Authorization: Bearer …`)',
  'read-token': 'project token with the `read` scope (`Authorization: Bearer …`)',
  'any-token': 'project token with either scope (`Authorization: Bearer …`)',
}

import { REST_ENDPOINTS, type RestEndpoint, TRPC_PROCEDURES } from '@flakemetry/contracts'
import type { ZodTypeAny } from 'zod'
import { zodToJsonSchema } from 'zod-to-json-schema'

interface JsonSchemaNode {
  type?: string | string[]
  description?: string
  enum?: unknown[]
  const?: unknown
  format?: string
  items?: JsonSchemaNode
  properties?: Record<string, JsonSchemaNode>
  required?: string[]
  anyOf?: JsonSchemaNode[]
  allOf?: JsonSchemaNode[]
  additionalProperties?: boolean | JsonSchemaNode
  $ref?: string
}

const describeType = (node: JsonSchemaNode | undefined): string => {
  if (!node) return 'unknown'
  if (node.enum) return node.enum.map((value) => `\`${JSON.stringify(value)}\``).join(' \\| ')
  if (node.const !== undefined) return `\`${JSON.stringify(node.const)}\``
  if (node.anyOf) {
    const parts = node.anyOf.filter((entry) => entry.type !== 'null').map(describeType)
    const nullable = node.anyOf.some((entry) => entry.type === 'null')
    return nullable ? `${parts.join(' \\| ')} \\| null` : parts.join(' \\| ')
  }
  if (node.$ref) return 'object'
  if (node.type === 'array') return `${describeType(node.items)}[]`
  if (node.type === 'object') return 'object'
  if (Array.isArray(node.type)) return node.type.join(' \\| ')
  if (node.format === 'date-time') return 'string (date-time)'
  return node.type ?? 'unknown'
}

const fieldTable = (name: string, schema: ZodTypeAny): string => {
  const json = zodToJsonSchema(schema, { $refStrategy: 'none' }) as JsonSchemaNode
  const properties = json.properties
  if (!properties) return ''

  const required = new Set(json.required ?? [])
  const rows = Object.entries(properties).map(([field, node]) => {
    const requiredMark = required.has(field) ? 'yes' : 'no'
    const description = node.description ?? ''
    return `| \`${field}\` | ${describeType(node)} | ${requiredMark} | ${description} |`
  })

  return [
    `**${name}**`,
    '',
    '| Field | Type | Required | Notes |',
    '| --- | --- | --- | --- |',
    ...rows,
    '',
  ].join('\n')
}

const endpointSection = (endpoint: RestEndpoint): string => {
  const lines = [
    `### \`${endpoint.method} ${endpoint.path}\``,
    '',
    endpoint.summary,
    '',
    `**Auth:** ${AUTH_LABELS[endpoint.auth]}`,
    '',
    `**Returns:** ${endpoint.response}`,
    '',
  ]
  if (endpoint.request) lines.push(fieldTable(endpoint.request.name, endpoint.request.schema))
  return lines.join('\n')
}

const render = (): string =>
  [
    '---',
    'outline: [2, 3]',
    '---',
    '',
    '# API reference',
    '',
    '::: warning Generated file',
    'This page is generated from the zod contracts and the router definitions at build time.',
    'Edit `packages/contracts/src/rest.ts` or the schemas themselves, not this page.',
    ':::',
    '',
    'Flakemetry exposes two surfaces: a **REST API** for ingestion and CI integrations,',
    'authenticated with a per-project ingest token, and a **tRPC API** for dashboard queries.',
    '',
    '## REST',
    '',
    'All request and response bodies are JSON. Write endpoints validate against the schemas below',
    'and reject anything that does not match, so a malformed upload fails fast rather than',
    'corrupting history.',
    '',
    ...REST_ENDPOINTS.map(endpointSection),
    '## tRPC',
    '',
    'The dashboard query API. Every procedure is scoped to the project the token belongs to.',
    '',
    ...TRPC_PROCEDURES.map((procedure) =>
      [
        `### \`${procedure.name}\``,
        '',
        procedure.summary,
        '',
        procedure.input ? fieldTable(procedure.input.name, procedure.input.schema) : '',
      ].join('\n'),
    ),
  ].join('\n')

const outputPath = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'reference', 'api.md')

writeFileSync(outputPath, `${render()}\n`)
process.stdout.write(`generated ${outputPath}\n`)
