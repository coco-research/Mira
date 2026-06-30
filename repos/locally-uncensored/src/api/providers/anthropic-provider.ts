/**
 * Anthropic Provider — Claude API
 *
 * Uses the Anthropic Messages API which has a different format from OpenAI:
 * - System prompt is a separate `system` param, not a message
 * - SSE events use `event: content_block_delta` format
 * - Tool calling uses `tool_use` content blocks
 * - No /models endpoint — model list is hardcoded
 */

import type {
  ProviderClient, ProviderModel, ProviderConfig, ChatMessage, ChatOptions,
  ChatStreamChunk, ToolCall, ToolDefinition,
} from './types'
import { ProviderError } from './types'
import { parseSSEWithEvents } from '../sse'

// ── Anthropic API Types ────────────────────────────────────────

interface AnthropicStreamEvent {
  type: string
  index?: number
  content_block?: { type: string; id?: string; name?: string; input?: any; text?: string }
  delta?: { type: string; text?: string; partial_json?: string; thinking?: string }
  message?: { id: string; usage?: { input_tokens: number; output_tokens: number } }
}

interface AnthropicResponse {
  content: {
    type: 'text' | 'tool_use'
    text?: string
    id?: string
    name?: string
    input?: Record<string, any>
  }[]
  stop_reason?: string
  usage?: { input_tokens: number; output_tokens: number }
}

// ── Known Claude models ────────────────────────────────────────

const CLAUDE_MODELS: ProviderModel[] = [
  { id: 'claude-opus-4-20250514', name: 'Claude Opus 4', provider: 'anthropic', providerName: 'Anthropic', contextLength: 200000, supportsTools: true, supportsVision: true },
  { id: 'claude-sonnet-4-20250514', name: 'Claude Sonnet 4', provider: 'anthropic', providerName: 'Anthropic', contextLength: 200000, supportsTools: true, supportsVision: true },
  { id: 'claude-haiku-4-5-20251001', name: 'Claude Haiku 4.5', provider: 'anthropic', providerName: 'Anthropic', contextLength: 200000, supportsTools: true, supportsVision: true },
]

// ── Provider Implementation ────────────────────────────────────

export class AnthropicProvider implements ProviderClient {
  readonly id = 'anthropic' as const

  constructor(private config: ProviderConfig) {}

  private get baseUrl(): string {
    return this.config.baseUrl.replace(/\/+$/, '')
  }

  /**
   * Bug O — v2.4.7. When users point the Anthropic provider at a proxy
   * (claude-relay-server, LiteLLM, opencode-zen, etc.) they sometimes
   * configure the baseUrl with `/v1` already included. Pre-v2.4.7 we always
   * appended `/v1/messages`, producing `https://proxy.example/v1/v1/messages`
   * which 404s silently. Strip a trailing `/v1` so users can paste whichever
   * shape their proxy docs use.
   */
  private messagesUrl(): string {
    const base = this.baseUrl
    if (/\/v1$/i.test(base)) {
      return `${base}/messages`
    }
    return `${base}/v1/messages`
  }

  private get headers(): Record<string, string> {
    return {
      'Content-Type': 'application/json',
      'x-api-key': this.config.apiKey,
      'anthropic-version': '2023-06-01',
      'anthropic-dangerous-direct-browser-access': 'true',
    }
  }

  async *chatStream(
    model: string,
    messages: ChatMessage[],
    options?: ChatOptions,
  ): AsyncGenerator<ChatStreamChunk> {
    const { system, anthropicMessages } = this.convertMessages(messages)

    const body: Record<string, any> = {
      model,
      messages: anthropicMessages,
      max_tokens: options?.maxTokens || 4096,
      stream: true,
    }

    if (system) body.system = system
    if (options?.temperature !== undefined) body.temperature = options.temperature
    if (options?.topP !== undefined) body.top_p = options.topP
    if (options?.topK !== undefined) body.top_k = options.topK
    // Claude Extended Thinking (Sonnet 3.7+, Opus 4). Opt-in: only when the
    // user actually toggled Thinking ON. Default stays OFF, so toggle OFF
    // simply omits the field. 5000 tokens is a sensible default budget —
    // the model may produce less, but won't exceed it.
    if (options?.thinking === true) {
      body.thinking = { type: 'enabled', budget_tokens: 5000 }
    }

    let res = await fetch(this.messagesUrl(), {
      method: 'POST',
      headers: this.headers,
      body: JSON.stringify(body),
      signal: options?.signal,
    })

    // Retry without extended thinking if the model rejects it (e.g. older
    // Claude versions don't support `thinking`).
    if (!res.ok && res.status === 400 && 'thinking' in body) {
      delete body.thinking
      res = await fetch(this.messagesUrl(), {
        method: 'POST',
        headers: this.headers,
        body: JSON.stringify(body),
        signal: options?.signal,
      })
    }

    if (!res.ok) {
      throw await this.parseError(res)
    }

    // Track tool use blocks being built
    const toolUseBlocks: Map<number, { id: string; name: string; input: string }> = new Map()

    for await (const { data } of parseSSEWithEvents<AnthropicStreamEvent>(res)) {
      if (options?.signal?.aborted) break

      switch (data.type) {
        case 'content_block_start': {
          if (data.content_block?.type === 'tool_use') {
            toolUseBlocks.set(data.index!, {
              id: data.content_block.id || '',
              name: data.content_block.name || '',
              input: '',
            })
          }
          break
        }

        case 'content_block_delta': {
          const dtype = (data.delta as any)?.type
          if (dtype === 'text_delta' && (data.delta as any).text) {
            yield { content: (data.delta as any).text, done: false }
          } else if (dtype === 'thinking_delta' && (data.delta as any).thinking) {
            // Claude Extended Thinking stream — route to `thinking` so the
            // ThinkingBlock UI picks it up (same field as Ollama's native).
            yield { content: '', thinking: (data.delta as any).thinking, done: false }
          } else if (dtype === 'input_json_delta' && (data.delta as any).partial_json) {
            const block = toolUseBlocks.get(data.index!)
            if (block) block.input += (data.delta as any).partial_json
          }
          break
        }

        case 'message_delta': {
          // End of message — flush tool calls
          const toolCalls = this.flushToolUseBlocks(toolUseBlocks)
          yield { content: '', toolCalls: toolCalls.length ? toolCalls : undefined, done: true }
          return
        }

        case 'message_stop': {
          const toolCalls2 = this.flushToolUseBlocks(toolUseBlocks)
          yield { content: '', toolCalls: toolCalls2.length ? toolCalls2 : undefined, done: true }
          return
        }
      }
    }

    // If stream ended without explicit message_stop
    const toolCalls = this.flushToolUseBlocks(toolUseBlocks)
    yield { content: '', toolCalls: toolCalls.length ? toolCalls : undefined, done: true }
  }

  async chatWithTools(
    model: string,
    messages: ChatMessage[],
    tools: ToolDefinition[],
    options?: ChatOptions,
  ): Promise<{ content: string; toolCalls: ToolCall[] }> {
    const { system, anthropicMessages } = this.convertMessages(messages)

    const body: Record<string, any> = {
      model,
      messages: anthropicMessages,
      max_tokens: options?.maxTokens || 4096,
    }

    if (system) body.system = system
    if (options?.temperature !== undefined) body.temperature = options.temperature
    if (options?.topP !== undefined) body.top_p = options.topP
    if (options?.topK !== undefined) body.top_k = options.topK
    // Same extended-thinking gate as chatStream.
    if (options?.thinking === true) {
      body.thinking = { type: 'enabled', budget_tokens: 5000 }
    }

    // Convert OpenAI tool format to Anthropic format
    if (tools.length > 0) {
      body.tools = tools.map(t => ({
        name: t.function.name,
        description: t.function.description,
        input_schema: t.function.parameters,
      }))
    }

    let res = await fetch(this.messagesUrl(), {
      method: 'POST',
      headers: this.headers,
      body: JSON.stringify(body),
      signal: options?.signal,
    })

    // Retry without extended thinking if the model rejects it.
    if (!res.ok && res.status === 400 && 'thinking' in body) {
      delete body.thinking
      res = await fetch(this.messagesUrl(), {
        method: 'POST',
        headers: this.headers,
        body: JSON.stringify(body),
        signal: options?.signal,
      })
    }

    if (!res.ok) {
      throw await this.parseError(res)
    }

    const data: AnthropicResponse = await res.json()

    let content = ''
    const toolCalls: ToolCall[] = []

    for (const block of data.content) {
      if (block.type === 'text') {
        content += block.text || ''
      } else if (block.type === 'tool_use') {
        toolCalls.push({
          id: block.id,
          function: {
            name: block.name!,
            arguments: (typeof block.input === 'object' && block.input) ? block.input : {},
          },
        })
      }
    }

    return { content, toolCalls }
  }

  async listModels(): Promise<ProviderModel[]> {
    // Anthropic has no public /models endpoint
    return [...CLAUDE_MODELS]
  }

  async checkConnection(): Promise<boolean> {
    if (!this.config.apiKey) return false

    try {
      // Send a minimal request to verify the API key
      const res = await fetch(this.messagesUrl(), {
        method: 'POST',
        headers: this.headers,
        body: JSON.stringify({
          model: 'claude-haiku-4-5-20251001',
          max_tokens: 1,
          messages: [{ role: 'user', content: 'hi' }],
        }),
      })
      // 200 or 400 (bad request but auth worked) both mean the key is valid
      return res.status !== 401 && res.status !== 403
    } catch {
      return false
    }
  }

  async getContextLength(model: string): Promise<number> {
    const known = CLAUDE_MODELS.find(m => model.includes(m.id.split('-').slice(0, 2).join('-')))
    return known?.contextLength || 200000
  }

  // ── Message conversion ───────────────────────────────────────

  private convertMessages(messages: ChatMessage[]): {
    system: string
    anthropicMessages: Record<string, any>[]
  } {
    let system = ''
    const anthropicMessages: Record<string, any>[] = []

    for (const msg of messages) {
      if (msg.role === 'system') {
        // Anthropic: system goes in a separate parameter
        system += (system ? '\n\n' : '') + msg.content
        continue
      }

      if (msg.role === 'tool') {
        // Anthropic tool results are user messages with tool_result content blocks
        anthropicMessages.push({
          role: 'user',
          content: [{
            type: 'tool_result',
            tool_use_id: msg.tool_call_id || 'unknown',
            content: msg.content,
          }],
        })
        continue
      }

      if (msg.role === 'assistant' && msg.tool_calls?.length) {
        // Assistant with tool calls → include tool_use content blocks
        const content: any[] = []
        if (msg.content) content.push({ type: 'text', text: msg.content })
        for (const tc of msg.tool_calls) {
          content.push({
            type: 'tool_use',
            id: tc.id || `toolu_${Math.random().toString(36).slice(2, 11)}`,
            name: tc.function.name,
            input: tc.function.arguments,
          })
        }
        anthropicMessages.push({ role: 'assistant', content })
        continue
      }

      // Regular user/assistant message — with optional images
      if (msg.images?.length && msg.role === 'user') {
        const content: any[] = []
        for (const img of msg.images) {
          content.push({
            type: 'image',
            source: { type: 'base64', media_type: img.mimeType, data: img.data },
          })
        }
        content.push({ type: 'text', text: msg.content })
        anthropicMessages.push({ role: 'user', content })
      } else {
        anthropicMessages.push({ role: msg.role, content: msg.content })
      }
    }

    // Anthropic requires messages to alternate user/assistant.
    // Merge consecutive same-role messages.
    const merged: Record<string, any>[] = []
    for (const msg of anthropicMessages) {
      const last = merged[merged.length - 1]
      if (last && last.role === msg.role && typeof last.content === 'string' && typeof msg.content === 'string') {
        last.content += '\n\n' + msg.content
      } else {
        merged.push(msg)
      }
    }

    return { system, anthropicMessages: merged }
  }

  // ── Tool call helpers ────────────────────────────────────────

  private flushToolUseBlocks(blocks: Map<number, { id: string; name: string; input: string }>): ToolCall[] {
    if (blocks.size === 0) return []

    const calls: ToolCall[] = []
    for (const [, block] of blocks) {
      let args: Record<string, any> = {}
      try { args = JSON.parse(block.input) } catch { /* empty */ }

      calls.push({
        id: block.id,
        function: { name: block.name, arguments: args },
      })
    }
    blocks.clear()
    return calls
  }

  // ── Error parsing ────────────────────────────────────────────

  private async parseError(res: Response): Promise<ProviderError> {
    let message = 'Anthropic: Request failed'
    let code: string = 'network'

    try {
      const data = await res.json()
      if (data.error?.message) message = data.error.message
    } catch { /* use default */ }

    if (res.status === 401 || res.status === 403) {
      code = 'auth'
      message = 'Invalid Anthropic API key. Check Settings > Providers.'
    } else if (res.status === 429) {
      code = 'rate_limit'
      message = 'Rate limited by Anthropic. Wait a moment and try again.'
    } else if (res.status === 404) {
      code = 'not_found'
    } else if (res.status === 529) {
      code = 'overloaded'
      message = 'Anthropic API is overloaded. Try again in a few seconds.'
    }

    return new ProviderError(message, 'anthropic', code, res.status)
  }
}
