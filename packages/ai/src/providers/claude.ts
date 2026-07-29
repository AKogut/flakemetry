import Anthropic from '@anthropic-ai/sdk'

import type { LlmProvider, LlmRequest, LlmResult } from '../provider'

export const DEFAULT_CLAUDE_MODEL = 'claude-opus-5'
export const DEFAULT_LLM_TIMEOUT_MS = 30_000

export interface ClaudeProviderOptions {
  apiKey?: string
  model?: string
  maxTokens?: number
  timeoutMs?: number
  client?: Anthropic
}

export const createClaudeProvider = (options: ClaudeProviderOptions = {}): LlmProvider => {
  const model = options.model ?? DEFAULT_CLAUDE_MODEL
  const timeoutMs = options.timeoutMs ?? DEFAULT_LLM_TIMEOUT_MS
  const client = options.client ?? new Anthropic(options.apiKey ? { apiKey: options.apiKey } : {})

  return {
    name: 'claude',
    model,
    async complete(request: LlmRequest): Promise<LlmResult> {
      const response = await client.messages.create(
        {
          model,
          max_tokens: request.maxTokens ?? options.maxTokens ?? 1024,
          system: request.system,
          messages: [{ role: 'user', content: request.prompt }],
        },
        { timeout: timeoutMs },
      )

      const text = response.content
        .filter((block): block is Anthropic.TextBlock => block.type === 'text')
        .map((block) => block.text)
        .join('')

      return {
        text,
        inputTokens: response.usage.input_tokens,
        outputTokens: response.usage.output_tokens,
      }
    },
  }
}
