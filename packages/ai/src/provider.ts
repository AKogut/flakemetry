export interface LlmRequest {
  system: string
  prompt: string
  maxTokens?: number
}

export interface LlmResult {
  text: string
  inputTokens: number
  outputTokens: number
}

export interface LlmProvider {
  readonly name: string
  readonly model: string
  complete(request: LlmRequest): Promise<LlmResult>
}
