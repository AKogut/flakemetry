import type { LlmProvider, LlmRequest, LlmResult } from '../provider'

export const DEFAULT_OLLAMA_MODEL = 'llama3.1'
export const DEFAULT_OLLAMA_ENDPOINT = 'http://localhost:11434'

export interface OllamaProviderOptions {
  endpoint?: string
  model?: string
  maxTokens?: number
  fetchImpl?: typeof fetch
}

interface OllamaChatResponse {
  message?: { content?: string }
  prompt_eval_count?: number
  eval_count?: number
}

export const createOllamaProvider = (options: OllamaProviderOptions = {}): LlmProvider => {
  const model = options.model ?? DEFAULT_OLLAMA_MODEL
  const endpoint = (options.endpoint ?? DEFAULT_OLLAMA_ENDPOINT).replace(/\/+$/, '')
  const fetchImpl = options.fetchImpl ?? globalThis.fetch

  return {
    name: 'ollama',
    model,
    async complete(request: LlmRequest): Promise<LlmResult> {
      const response = await fetchImpl(`${endpoint}/api/chat`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          model,
          stream: false,
          format: 'json',
          options: { num_predict: request.maxTokens ?? options.maxTokens ?? 1024 },
          messages: [
            { role: 'system', content: request.system },
            { role: 'user', content: request.prompt },
          ],
        }),
      })

      if (!response.ok) throw new Error(`ollama request failed with status ${response.status}`)

      const body = (await response.json()) as OllamaChatResponse
      return {
        text: body.message?.content ?? '',
        inputTokens: body.prompt_eval_count ?? 0,
        outputTokens: body.eval_count ?? 0,
      }
    },
  }
}
