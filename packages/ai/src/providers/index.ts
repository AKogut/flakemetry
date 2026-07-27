import type { LlmProvider } from '../provider'
import { type ClaudeProviderOptions, createClaudeProvider } from './claude'
import { createOllamaProvider, type OllamaProviderOptions } from './ollama'

export * from './claude'
export * from './ollama'

export interface ResolveProviderDeps {
  createClaude?: (options: ClaudeProviderOptions) => LlmProvider
  createOllama?: (options: OllamaProviderOptions) => LlmProvider
}

export const resolveProvider = (
  env: Record<string, string | undefined>,
  deps: ResolveProviderDeps = {},
): LlmProvider | null => {
  const makeClaude = deps.createClaude ?? createClaudeProvider
  const makeOllama = deps.createOllama ?? createOllamaProvider
  const selected = (env.FLAKEMETRY_AI_PROVIDER ?? '').toLowerCase()
  const apiKey = env.FLAKEMETRY_AI_API_KEY || env.ANTHROPIC_API_KEY
  const model = env.FLAKEMETRY_AI_MODEL || undefined

  if (selected === 'ollama') {
    return makeOllama({
      endpoint: env.FLAKEMETRY_AI_ENDPOINT || env.OLLAMA_HOST || undefined,
      model,
    })
  }

  if (selected === 'claude' || (selected === '' && apiKey)) {
    if (!apiKey) return null
    return makeClaude({ apiKey, model })
  }

  return null
}
