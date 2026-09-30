import { z } from 'zod'

import { type TestStatus, testStatusSchema } from './common'
import { ingestResourceSchema } from './ingestion'

export const PLUGIN_API_VERSION = 1

export const MAX_SIGNALS_PER_ANALYZER = 1000

export const MAX_HISTORY_PER_TEST = 200

export const pluginNameSchema = z
  .string()
  .regex(/^[a-z][a-z0-9-]{1,48}$/, 'a plugin name is lowercase letters, digits and dashes')

export const pluginSignalSchema = z.object({
  testIdentityId: z.string().uuid(),
  code: z
    .string()
    .regex(/^[A-Z][A-Z0-9_]{2,47}$/, 'a signal code is upper snake case, like SLOW_OUTLIER'),
  severity: z.enum(['info', 'warning']),
  message: z.string().min(1).max(500),
  data: z.record(z.string(), z.unknown()).optional(),
})

export const pluginSignalsSchema = z.array(pluginSignalSchema).max(MAX_SIGNALS_PER_ANALYZER)

export const parsedExecutionSchema = z.object({
  filePath: z.string().min(1).max(1024),
  suite: z.string().max(1024),
  title: z.string().min(1).max(2048),
  status: testStatusSchema,
  durationMs: z.number().int().nonnegative(),
  error: z
    .object({
      type: z.string().nullable().optional(),
      message: z.string().min(1),
      stack: z.string().nullable().optional(),
    })
    .nullable()
    .optional(),
})

export const parsedReportSchema = z.object({
  startedAt: z.string().nullable(),
  executions: z.array(parsedExecutionSchema).max(5000),
})

export const pluginIngestRequestSchema = z.object({
  idempotencyKey: z.string().min(8),
  resource: ingestResourceSchema,
  content: z.string().min(1),
})

export type PluginSignal = z.infer<typeof pluginSignalSchema>
export type ParsedExecution = z.infer<typeof parsedExecutionSchema>
export type ParsedReport = z.infer<typeof parsedReportSchema>
export type PluginIngestRequest = z.infer<typeof pluginIngestRequestSchema>

export interface AnalyzerExecution {
  testIdentityId: string
  filePath: string
  suite: string
  title: string
  status: TestStatus
  attempt: number
  durationMs: number
  errorMessage: string | null
}

export interface AnalyzerInput {
  projectId: string
  run: { id: string; commitSha: string; branch: string; startedAt: Date }
  executions: AnalyzerExecution[]
}

export interface AnalyzerHistoryEntry {
  runId: string
  commitSha: string
  startedAt: Date
  status: TestStatus
  attempt: number
  durationMs: number
}

export interface AnalyzerContext {
  history: (
    testIdentityIds: readonly string[],
    options?: { limit?: number },
  ) => Promise<Record<string, AnalyzerHistoryEntry[]>>
  deadline: Date
}

export interface FlakemetryPlugin {
  name: string
  apiVersion: typeof PLUGIN_API_VERSION
  analyze?: (
    input: AnalyzerInput,
    context: AnalyzerContext,
  ) => PluginSignal[] | Promise<PluginSignal[]>
  parse?: (content: string) => ParsedReport | Promise<ParsedReport>
}

export const definePlugin = <T extends FlakemetryPlugin>(plugin: T): T => plugin

const pluginShapeSchema = z.object({
  name: pluginNameSchema,
  apiVersion: z.number().int(),
  analyze: z.unknown().optional(),
  parse: z.unknown().optional(),
})

export const validatePlugin = (candidate: unknown, source: string): FlakemetryPlugin => {
  const shape = pluginShapeSchema.safeParse(candidate)
  if (!shape.success) {
    const issue = shape.error.issues[0]
    throw new Error(
      `plugin ${source} is not a Flakemetry plugin: ${issue?.path.join('.') || 'value'} ${issue?.message ?? ''}`.trim(),
    )
  }
  const plugin = shape.data
  if (plugin.apiVersion !== PLUGIN_API_VERSION) {
    throw new Error(
      `plugin ${plugin.name} targets plugin API ${plugin.apiVersion}; this server supports ${PLUGIN_API_VERSION}`,
    )
  }
  if (plugin.analyze !== undefined && typeof plugin.analyze !== 'function') {
    throw new Error(`plugin ${plugin.name}: analyze must be a function`)
  }
  if (plugin.parse !== undefined && typeof plugin.parse !== 'function') {
    throw new Error(`plugin ${plugin.name}: parse must be a function`)
  }
  if (plugin.analyze === undefined && plugin.parse === undefined) {
    throw new Error(`plugin ${plugin.name} provides neither analyze nor parse`)
  }
  return candidate as FlakemetryPlugin
}
