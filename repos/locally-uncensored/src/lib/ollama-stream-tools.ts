import type { ChatMessage, ToolCall, ToolDefinition } from '../api/providers/types'
import { ollamaUrl, localFetchStream } from '../api/backend'
import { repairToolCallArgs } from './tool-call-repair'

/**
 * Streaming Ollama `/api/chat` call with native `tools` support.
 *
 * Originally lived inline in `useCodex.ts` — extracted so the regular
 * Agent path (`useAgentChat.ts`) can share the exact same wire protocol
 * + chunk-state-machine + arg-repair logic. Without this hook, Agent
 * Mode used the non-streaming provider call → UI froze for 30-90 s
 * while the model thought, no live tokens, no live tool-call hint.
 *
 * Behaviour notes:
 *  - Uses `localFetchStream` (Tauri-aware) so Tauri WebView can hit
 *    localhost:11434 via the Rust proxy when the direct fetch fails.
 *  - Falls back to retry-without-`think` on HTTP 400 (old Ollama
 *    builds reject the field).
 *  - `tool_calls` chunks may arrive split across multiple NDJSON
 *    lines — appends instead of overwriting.
 *  - `repairToolCallArgs` handles the case where Ollama emits the
 *    arguments object as a JSON-stringified blob instead of a real
 *    object (the bug behind "file_write needs argument" on small
 *    models).
 */
export async function streamOllamaChatWithTools(
  modelId: string,
  messages: ChatMessage[],
  tools: ToolDefinition[],
  options: { temperature?: number; thinking?: boolean; maxTokens?: number; contextWindow?: number; signal?: AbortSignal },
  onContent: (content: string) => void,
  onThinking: (thinking: string) => void,
): Promise<{ content: string; toolCalls: ToolCall[]; thinking: string; promptEvalCount: number; evalCount: number }> {
  const ollamaMessages = messages.map((m) => {
    const msg: Record<string, any> = { role: m.role, content: m.content }
    if (m.tool_calls) msg.tool_calls = m.tool_calls
    if ((m as any).images?.length) msg.images = (m as any).images.map((img: any) => img.data)
    return msg
  })

  // v2.4.6 Bug L: dropped hardcoded `num_gpu: 99` — see src/api/ollama.ts
  // for the full rationale. Ollama now decides layer placement itself,
  // which restores CLI parity on 8 GB laptop cards.
  const body: Record<string, any> = {
    model: modelId,
    messages: ollamaMessages,
    tools,
    stream: true,
    options: {},
  }
  if (options.temperature !== undefined) body.options.temperature = options.temperature
  if (options.maxTokens) body.options.num_predict = options.maxTokens
  // Bug AA v2.5.0 — forward num_ctx override (0/undefined = use Ollama default).
  if (options.contextWindow && options.contextWindow > 0) {
    body.options.num_ctx = options.contextWindow
  }
  if (options.thinking === true) body.think = true
  else if (options.thinking === false) body.think = false

  const url = ollamaUrl('/chat')
  let response: Response
  try {
    response = await localFetchStream(url, {
      method: 'POST',
      body: JSON.stringify(body),
      signal: options.signal,
    })
  } catch (fetchErr) {
    throw fetchErr
  }

  if (!response.ok && response.status === 400 && 'think' in body) {
    delete body.think
    response = await localFetchStream(url, {
      method: 'POST',
      body: JSON.stringify(body),
      signal: options.signal,
    })
  }

  if (!response.ok) {
    const text = await response.text()
    const err = new Error(`HTTP ${response.status}: ${text}`) as any
    err.statusCode = response.status
    throw err
  }

  const reader = response.body!.getReader()
  const decoder = new TextDecoder()
  let buf = ''
  let content = ''
  let thinking = ''
  let toolCalls: ToolCall[] = []
  // Real token usage from the final Ollama chunk (top-level, not in `message`).
  // prompt_eval_count is the FULL consumed context (system + tools + RAG +
  // history) for THIS turn — the agent/code loop stores the latest so the
  // TokenCounter shows 100% real usage instead of a char/4 estimate.
  let promptEvalCount = 0
  let evalCount = 0

  while (true) {
    if (options.signal?.aborted) {
      try { await reader.cancel() } catch { /* noop */ }
      break
    }
    const { done, value } = await reader.read()
    if (done) break

    buf += decoder.decode(value, { stream: true })
    const lines = buf.split('\n')
    buf = lines.pop() || ''

    for (const line of lines) {
      const trimmed = line.trim()
      if (!trimmed) continue
      // Parse and process are separated on purpose: the catch only covers the
      // JSON.parse (partial lines are normal in a chunked stream), while a
      // real `{"error":...}` line must THROW past it.
      let j: any
      try {
        j = JSON.parse(trimmed)
      } catch {
        continue // partial JSON line — skip
      }
      // Ollama reports mid-stream failures (runner crash, OOM, context
      // overflow on some builds) as an NDJSON line `{"error":"..."}` inside
      // an HTTP-200 stream. Swallowing it produced an EMPTY turn — the agent
      // loop then surfaced a bare "Agent error" with zero context (rikki
      // Discord 2026-06-10). Throw so the caller's retry/classify logic runs.
      if (typeof j.error === 'string' && j.error) {
        throw new Error(`Ollama: ${j.error}`)
      }
      if (j.message) {
        if (j.message.content) {
          content += j.message.content
          onContent(content)
        }
        if (j.message.thinking) {
          thinking += j.message.thinking
          onThinking(thinking)
        }
        if (j.message.tool_calls && Array.isArray(j.message.tool_calls)) {
          toolCalls = [
            ...toolCalls,
            ...j.message.tool_calls.map((tc: any) => ({
              function: {
                name: tc.function.name,
                arguments: repairToolCallArgs(tc.function.arguments),
              },
            })),
          ]
        }
      }
      if (typeof j.prompt_eval_count === 'number') promptEvalCount = j.prompt_eval_count
      if (typeof j.eval_count === 'number') evalCount = j.eval_count
    }
  }

  if (buf.trim()) {
    let j: any
    try {
      j = JSON.parse(buf.trim())
    } catch {
      j = null // ignore tail-buffer parse errors
    }
    if (j) {
      if (typeof j.error === 'string' && j.error) {
        throw new Error(`Ollama: ${j.error}`)
      }
      if (j.message?.tool_calls && Array.isArray(j.message.tool_calls)) {
        toolCalls = [
          ...toolCalls,
          ...j.message.tool_calls.map((tc: any) => ({
            function: {
              name: tc.function.name,
              arguments: repairToolCallArgs(tc.function.arguments),
            },
          })),
        ]
      }
      if (j.message?.content) {
        content += j.message.content
        onContent(content)
      }
      if (j.message?.thinking) {
        thinking += j.message.thinking
        onThinking(thinking)
      }
      if (typeof j.prompt_eval_count === 'number') promptEvalCount = j.prompt_eval_count
      if (typeof j.eval_count === 'number') evalCount = j.eval_count
    }
  }

  return { content, toolCalls, thinking, promptEvalCount, evalCount }
}
