import type { AgentBlock } from './agent-mode'

export type Role = 'user' | 'assistant' | 'system' | 'tool'

export interface ImageAttachment {
  data: string       // base64 encoded
  mimeType: string   // e.g. 'image/png', 'image/jpeg'
  name: string       // filename
}

/**
 * A chat-tools "artifact": a file the model produced in PLAIN chat. In chat
 * mode `file_write` does NOT touch disk (ChatGPT-style) — the content lands in
 * the message and renders inline with a preview + Download button. (The Coding
 * Agent still writes to its real working directory.)
 */
export interface ChatArtifact {
  id: string
  /** Filename the model chose, e.g. "report.md". */
  name: string
  /** The text content the model "wrote". */
  content: string
  /** MIME type, derived from the extension — drives the preview. */
  mime: string
}

export interface Message {
  id: string
  role: Role
  content: string
  /** When set, the UI renders THIS instead of `content` for a user message.
   *  Agent slash commands (v2.5.3): the user sees the short "/commit" they
   *  typed, while `content` holds the full expanded instruction the model
   *  actually receives. Display-only — never sent to the model. */
  displayContent?: string
  /** Coding-Agent slash command that triggered this assistant turn (e.g.
   *  "review", "init"). When set, CodexView wraps the whole step transcript in a
   *  collapsible tool-call-style window — default collapsed, live-streams while
   *  running (David 2026-06-12). Undefined for normal coding instructions. */
  slashCommand?: string
  thinking?: string
  timestamp: number
  images?: ImageAttachment[]
  sources?: { documentName: string; chunkIndex: number; preview: string }[]
  // Agent Mode fields
  agentBlocks?: AgentBlock[]
  toolCallSummary?: string
  /** Chat-tools artifacts — files "written" in plain chat, rendered inline
   *  with preview + Download (never touch disk). See ChatArtifact. */
  artifacts?: ChatArtifact[]
  // Continue capability — tool-call history persisted between turns so
  // the model sees what it did before (parity with original Codex CLI).
  // Hidden messages are included in the API payload but not rendered.
  hidden?: boolean
  tool_calls?: { function: { name: string; arguments: Record<string, unknown> } }[]
  // Real token usage reported by the model (Ollama prompt_eval_count/eval_count,
  // OpenAI/LM-Studio usage.*). promptTokens = the FULL consumed context for that
  // turn (system prompt + tools + RAG + history + input), so it powers a
  // 100%-real context readout instead of a char/4 estimate.
  // promptTokens = the FULL consumed context (system prompt + tools + RAG +
  // history + input). `estimated` is true for the provisional value the agent
  // loop sets BEFORE the model replies (so the counter isn't a tiny char/4 guess
  // of only the visible messages); it flips to false once the model reports the
  // exact prompt_eval_count / usage.prompt_tokens.
  usage?: { promptTokens: number; completionTokens: number; totalTokens: number; estimated?: boolean }
}

export interface Conversation {
  id: string
  title: string
  messages: Message[]
  model: string
  systemPrompt: string
  mode?: 'lu' | 'codex' | 'openclaw' | 'remote'
  /** Per-chat persona toggle. Mirrors the mobile chat's `personaEnabled`
   *  flag so the user can flip the persona on/off for each chat
   *  individually without losing the selection in Settings. Undefined
   *  on legacy chats and treated as enabled. */
  personaEnabled?: boolean
  createdAt: number
  updatedAt: number
}
