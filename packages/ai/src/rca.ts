import { z } from 'zod'

import type { LlmProvider } from './provider'
import { type ScrubbableError, scrubError } from './scrub'

export const rcaAnalysisSchema = z.object({
  summary: z.string().min(1),
  likelyCause: z.string().min(1),
  suggestedAction: z.string().min(1),
  confidence: z.number().min(0).max(1),
})

export type RcaAnalysis = z.infer<typeof rcaAnalysisSchema>

export interface RcaInput {
  testTitle: string
  suite: string
  filePath: string
  error: ScrubbableError
  flakyScore?: number | null
}

export interface RcaOutcome {
  analysis: RcaAnalysis
  model: string
  tokenCost: number
}

export const RCA_SYSTEM_PROMPT =
  'You are a test failure root-cause analyst for a flaky-test intelligence platform. ' +
  'Given a failed test and its scrubbed error, produce a concise, actionable root-cause analysis. ' +
  'Respond with ONLY a JSON object with keys "summary", "likelyCause", "suggestedAction", and ' +
  '"confidence" (a number between 0 and 1). No prose, no markdown fences.'

export const buildRcaPrompt = (input: RcaInput): string => {
  const error = scrubError(input.error)
  const lines = [`Test: ${input.suite} › ${input.testTitle}`, `File: ${input.filePath}`]
  if (input.flakyScore != null) lines.push(`Current flaky score: ${input.flakyScore.toFixed(2)}`)
  lines.push(`Error type: ${error.type ?? 'unknown'}`, `Error message: ${error.message}`)
  if (error.stack) lines.push(`Stack:\n${error.stack}`)
  return lines.join('\n')
}

export const parseRcaAnalysis = (text: string): RcaAnalysis | null => {
  const start = text.indexOf('{')
  const end = text.lastIndexOf('}')
  if (start === -1 || end <= start) return null
  try {
    const parsed = rcaAnalysisSchema.safeParse(JSON.parse(text.slice(start, end + 1)))
    return parsed.success ? parsed.data : null
  } catch {
    return null
  }
}

export const analyzeFailure = async (
  provider: LlmProvider,
  input: RcaInput,
): Promise<RcaOutcome | null> => {
  const result = await provider.complete({
    system: RCA_SYSTEM_PROMPT,
    prompt: buildRcaPrompt(input),
    maxTokens: 1024,
  })
  const analysis = parseRcaAnalysis(result.text)
  if (!analysis) return null
  return {
    analysis,
    model: provider.model,
    tokenCost: result.inputTokens + result.outputTokens,
  }
}
