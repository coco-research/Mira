/**
 * streamOllamaChatWithTools error-path tests (rikki Discord 2026-06-10).
 *
 * Ollama reports mid-stream failures (runner crash, OOM) as an NDJSON line
 * `{"error":"..."}` inside an HTTP-200 stream. Before the fix the parser
 * silently skipped those lines → EMPTY agent turn → bare "Agent error" with
 * zero context. Also pins the 400 think-field downgrade, which only works on
 * Windows now that the proxy path carries faithful HTTP statuses.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../../api/backend', () => ({
  ollamaUrl: (path: string) => `/api${path}`,
  localFetchStream: vi.fn(),
}))

import { streamOllamaChatWithTools } from '../ollama-stream-tools'
import { localFetchStream } from '../../api/backend'

const mockStream = localFetchStream as ReturnType<typeof vi.fn>

const run = () =>
  streamOllamaChatWithTools(
    'test-model',
    [{ role: 'user', content: 'hi' }],
    [],
    {},
    () => {},
    () => {},
  )

beforeEach(() => {
  vi.clearAllMocks()
})

describe('streamOllamaChatWithTools — NDJSON error lines', () => {
  it('throws on a mid-stream {"error":...} line instead of returning an empty turn', async () => {
    mockStream.mockResolvedValueOnce(new Response(
      '{"message":{"content":"thinking about it"}}\n' +
      '{"error":"llama runner process has terminated: exit status 2"}\n',
      { status: 200 },
    ))
    await expect(run()).rejects.toThrow(/llama runner process has terminated/)
  })

  it('throws on an error line sitting in the tail buffer (no trailing newline)', async () => {
    mockStream.mockResolvedValueOnce(new Response('{"error":"model requires more system memory"}', { status: 200 }))
    await expect(run()).rejects.toThrow(/more system memory/)
  })

  it('still parses content, tool calls and token counts on the happy path', async () => {
    mockStream.mockResolvedValueOnce(new Response(
      '{"message":{"content":"hi","tool_calls":[{"function":{"name":"web_search","arguments":{"query":"x"}}}]}}\n' +
      '{"done":true,"prompt_eval_count":5,"eval_count":7}\n',
      { status: 200 },
    ))
    const turn = await run()
    expect(turn.content).toBe('hi')
    expect(turn.toolCalls).toHaveLength(1)
    expect(turn.toolCalls[0].function.name).toBe('web_search')
    expect(turn.promptEvalCount).toBe(5)
    expect(turn.evalCount).toBe(7)
  })

  it('skips partial JSON lines without dying', async () => {
    mockStream.mockResolvedValueOnce(new Response(
      '{"message":{"content":"ok"}}\n{"mess\n',
      { status: 200 },
    ))
    const turn = await run()
    expect(turn.content).toBe('ok')
  })
})

describe('streamOllamaChatWithTools — think-field 400 downgrade', () => {
  it('retries once without `think` when the server answers 400 (now status-faithful via proxy)', async () => {
    mockStream
      .mockResolvedValueOnce(new Response('{"error":"registry model does not support thinking"}', { status: 400 }))
      .mockResolvedValueOnce(new Response('{"message":{"content":"ok"}}\n', { status: 200 }))

    const turn = await streamOllamaChatWithTools(
      'test-model',
      [{ role: 'user', content: 'hi' }],
      [],
      { thinking: true },
      () => {},
      () => {},
    )
    expect(turn.content).toBe('ok')
    expect(mockStream).toHaveBeenCalledTimes(2)
    const firstBody = JSON.parse(mockStream.mock.calls[0][1].body)
    const secondBody = JSON.parse(mockStream.mock.calls[1][1].body)
    expect(firstBody.think).toBe(true)
    expect('think' in secondBody).toBe(false)
  })

  it('throws with the real status code on a non-think 400', async () => {
    mockStream.mockResolvedValueOnce(new Response('{"error":"model does not support tools"}', { status: 400 }))
    await expect(run()).rejects.toMatchObject({ statusCode: 400 })
  })
})
