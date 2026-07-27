import { describe, expect, it, vi } from 'vitest'

import type { LlmProvider } from '../provider'
import { createOllamaProvider, resolveProvider } from '../providers'

const stub = (name: string): LlmProvider => ({ name, model: 'm', complete: vi.fn() })

describe('createOllamaProvider', () => {
  it('posts a chat request and maps content and token counts', async () => {
    const fetchImpl = vi.fn(async () => ({
      ok: true,
      json: async () => ({
        message: { content: '{"ok":true}' },
        prompt_eval_count: 55,
        eval_count: 12,
      }),
    })) as unknown as typeof fetch

    const provider = createOllamaProvider({ endpoint: 'http://ollama:11434/', fetchImpl })
    const result = await provider.complete({ system: 'sys', prompt: 'why did it fail?' })

    expect(result).toEqual({ text: '{"ok":true}', inputTokens: 55, outputTokens: 12 })
    const call = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls[0] as [
      string,
      { body: string },
    ]
    expect(call[0]).toBe('http://ollama:11434/api/chat')
    expect(JSON.parse(call[1].body).messages[1].content).toBe('why did it fail?')
  })

  it('throws on a non-ok response', async () => {
    const fetchImpl = vi.fn(async () => ({ ok: false, status: 500 })) as unknown as typeof fetch
    await expect(
      createOllamaProvider({ fetchImpl }).complete({ system: 's', prompt: 'p' }),
    ).rejects.toThrow('500')
  })
})

describe('resolveProvider', () => {
  const deps = {
    createClaude: vi.fn(() => stub('claude')),
    createOllama: vi.fn(() => stub('ollama')),
  }

  it('returns null when nothing is configured', () => {
    expect(resolveProvider({}, deps)).toBeNull()
  })

  it('defaults to claude when an API key is present', () => {
    expect(resolveProvider({ ANTHROPIC_API_KEY: 'sk-x' }, deps)?.name).toBe('claude')
    expect(deps.createClaude).toHaveBeenCalledWith(expect.objectContaining({ apiKey: 'sk-x' }))
  })

  it('selects ollama explicitly without needing a key', () => {
    const provider = resolveProvider(
      { FLAKEMETRY_AI_PROVIDER: 'ollama', FLAKEMETRY_AI_ENDPOINT: 'http://host:11434' },
      deps,
    )
    expect(provider?.name).toBe('ollama')
    expect(deps.createOllama).toHaveBeenCalledWith(
      expect.objectContaining({ endpoint: 'http://host:11434' }),
    )
  })

  it('returns null when claude is selected but no key is available', () => {
    expect(resolveProvider({ FLAKEMETRY_AI_PROVIDER: 'claude' }, deps)).toBeNull()
  })
})
