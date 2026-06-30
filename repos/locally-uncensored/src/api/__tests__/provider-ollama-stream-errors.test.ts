/**
 * OllamaProvider.chatStream error-line test (rikki Discord 2026-06-10).
 *
 * Plain chat shares the same Ollama NDJSON wire format as the agent path:
 * a mid-stream `{"error":"..."}` line inside an HTTP-200 stream means the
 * runner died. The stream loop must throw instead of yielding nothing.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { ProviderConfig } from '../providers/types'

vi.mock('../backend', () => ({
  isTauri: () => false,
  localFetch: vi.fn(),
  localFetchStream: vi.fn(),
  ollamaUrl: (path: string) => `/api${path}`,
}))

import { OllamaProvider } from '../providers/ollama-provider'
import { localFetchStream } from '../backend'

const mockLocalFetchStream = localFetchStream as ReturnType<typeof vi.fn>

const config: ProviderConfig = {
  id: 'ollama',
  name: 'Ollama',
  enabled: true,
  baseUrl: 'http://localhost:11434',
  apiKey: '',
  isLocal: true,
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe('OllamaProvider.chatStream — mid-stream error lines', () => {
  it('throws on {"error":...} instead of ending as a silent empty reply', async () => {
    mockLocalFetchStream.mockResolvedValueOnce(new Response(
      '{"message":{"content":"par"},"done":false}\n' +
      '{"error":"llama runner process has terminated: signal: killed"}\n',
      { status: 200 },
    ))

    const provider = new OllamaProvider(config)
    const collect = async () => {
      const chunks: string[] = []
      for await (const c of provider.chatStream('m', [{ role: 'user', content: 'hi' }])) {
        chunks.push(c.content)
      }
      return chunks
    }
    await expect(collect()).rejects.toThrow(/llama runner process has terminated/)
  })

  it('still yields normal chunks', async () => {
    mockLocalFetchStream.mockResolvedValueOnce(new Response(
      '{"message":{"content":"hello"},"done":false}\n' +
      '{"message":{"content":""},"done":true,"eval_count":3}\n',
      { status: 200 },
    ))

    const provider = new OllamaProvider(config)
    const contents: string[] = []
    let evalCount: number | undefined
    for await (const c of provider.chatStream('m', [{ role: 'user', content: 'hi' }])) {
      contents.push(c.content)
      if (c.evalCount !== undefined) evalCount = c.evalCount
    }
    expect(contents.join('')).toBe('hello')
    expect(evalCount).toBe(3)
  })
})
