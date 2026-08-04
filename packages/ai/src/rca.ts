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

export interface PriorAnalysis {
  summary: string
  resolution: string
}

export interface RcaInput {
  testTitle: string
  suite: string
  filePath: string
  error: ScrubbableError
  flakyScore?: number | null
  similarPast?: readonly PriorAnalysis[]
}

export interface RcaOutcome {
  analysis: RcaAnalysis
  model: string
  tokenCost: number
  groundedIn: number
}

export const MAX_PRIOR_ANALYSES = 4

export const RCA_SYSTEM_PROMPT =
  'You are a test failure root-cause analyst for a flaky-test intelligence platform. ' +
  'Given a failed test and its scrubbed error, produce a concise, actionable root-cause analysis. ' +
  'You may be shown analyses of earlier failures from the same project. Use them when they ' +
  'genuinely explain this failure, and say so in the summary; ignore them when they do not, ' +
  'rather than forcing a match. Let the confidence reflect that: higher when earlier cases ' +
  'corroborate this one, lower when the evidence is thin or the prior cases do not fit. ' +
  'Respond with ONLY a JSON object with keys "summary", "likelyCause", "suggestedAction", and ' +
  '"confidence" (a number between 0 and 1). No prose, no markdown fences.'

export const buildRcaPrompt = (input: RcaInput): string => {
  const error = scrubError(input.error)
  const lines = [`Test: ${input.suite} › ${input.testTitle}`, `File: ${input.filePath}`]
  if (input.flakyScore != null) lines.push(`Current flaky score: ${input.flakyScore.toFixed(2)}`)
  lines.push(`Error type: ${error.type ?? 'unknown'}`, `Error message: ${error.message}`)
  if (error.stack) lines.push(`Stack:\n${error.stack}`)

  const priors = (input.similarPast ?? []).slice(0, MAX_PRIOR_ANALYSES)
  if (priors.length > 0) {
    lines.push('', `Earlier failures in this project (${priors.length}), most recent first:`)
    priors.forEach((prior, index) => {
      lines.push(`${index + 1}. Cause: ${prior.summary}`, `   Resolution: ${prior.resolution}`)
    })
  }

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
    groundedIn: Math.min(input.similarPast?.length ?? 0, MAX_PRIOR_ANALYSES),
  }
}
