import type { LlmProvider } from './provider'
import { analyzeFailure, type RcaAnalysis, type RcaInput } from './rca'

export interface EvalExpectation {
  causeKeywords: string[]
  actionKeywords: string[]
}

export interface EvalCase {
  id: string
  input: RcaInput
  expect: EvalExpectation
}

export interface CaseScore {
  id: string
  answered: boolean
  causeRecall: number
  actionRecall: number
  score: number
}

export interface EvalReport {
  promptVersion: string
  cases: CaseScore[]
  answeredRate: number
  meanScore: number
}

const recall = (haystack: string, keywords: readonly string[]): number => {
  if (keywords.length === 0) return 1
  const text = haystack.toLowerCase()
  const hit = keywords.filter((keyword) => text.includes(keyword.toLowerCase())).length
  return hit / keywords.length
}

/**
 * Deliberately keyword recall rather than a model grading a model. It is a blunt
 * measure and does not judge whether an explanation reads well — but it is
 * deterministic, needs no provider to score, and moves for the same reason a human
 * would say the answer got worse: the cause or the fix stopped being mentioned.
 */
export const scoreAnalysis = (
  analysis: RcaAnalysis | null,
  expectation: EvalExpectation,
): Omit<CaseScore, 'id'> => {
  if (!analysis) return { answered: false, causeRecall: 0, actionRecall: 0, score: 0 }

  const causeRecall = recall(
    `${analysis.summary} ${analysis.likelyCause}`,
    expectation.causeKeywords,
  )
  const actionRecall = recall(analysis.suggestedAction, expectation.actionKeywords)

  return {
    answered: true,
    causeRecall,
    actionRecall,
    score: (causeRecall + actionRecall) / 2,
  }
}

export const runEval = async (
  provider: LlmProvider,
  cases: readonly EvalCase[],
  promptVersion: string,
): Promise<EvalReport> => {
  const scored: CaseScore[] = []

  for (const testCase of cases) {
    const outcome = await analyzeFailure(provider, testCase.input)
    scored.push({ id: testCase.id, ...scoreAnalysis(outcome?.analysis ?? null, testCase.expect) })
  }

  const answered = scored.filter((entry) => entry.answered).length
  const total = scored.length || 1

  return {
    promptVersion,
    cases: scored,
    answeredRate: answered / total,
    meanScore: scored.reduce((sum, entry) => sum + entry.score, 0) / total,
  }
}

export interface EvalGate {
  passed: boolean
  reasons: string[]
}

/**
 * The point of the whole exercise: a prompt change is accepted or rejected on movement,
 * not on how the new wording feels to whoever wrote it. Ties pass — a change that costs
 * nothing measurable is allowed through on other grounds.
 */
export const compareToBaseline = (
  baseline: Pick<EvalReport, 'meanScore' | 'answeredRate'>,
  candidate: Pick<EvalReport, 'meanScore' | 'answeredRate'>,
  tolerance = 0.01,
): EvalGate => {
  const reasons: string[] = []

  if (candidate.meanScore < baseline.meanScore - tolerance) {
    reasons.push(
      `mean score fell from ${baseline.meanScore.toFixed(3)} to ${candidate.meanScore.toFixed(3)}`,
    )
  }
  if (candidate.answeredRate < baseline.answeredRate - tolerance) {
    reasons.push(
      `answered rate fell from ${baseline.answeredRate.toFixed(3)} to ${candidate.answeredRate.toFixed(3)}`,
    )
  }

  return { passed: reasons.length === 0, reasons }
}
