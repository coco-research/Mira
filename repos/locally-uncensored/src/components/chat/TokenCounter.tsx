import { useChatStore } from '../../stores/chatStore'
import { estimateTokens } from '../../lib/context-compaction'
import { useActiveContextWindow } from '../../hooks/useActiveContextWindow'

export function TokenCounter() {
  const activeConversationId = useChatStore((s) => s.activeConversationId)
  const conversations = useChatStore((s) => s.conversations)

  // The denominator is the REAL context window the active model runs with —
  // provider-aware and shared with the Context dropdown so the two never drift
  // (David: "muss immer stimmen"). Ollama = the num_ctx we send; LM Studio =
  // loaded_context_length (what it actually loaded), NOT the model's max.
  const ctx = useActiveContextWindow()

  const conversation = conversations.find((c) => c.id === activeConversationId)
  const messages = conversation?.messages || []

  // 100%-REAL usage: the latest assistant message's model-reported usage.
  // promptTokens already includes the system prompt, tools, RAG and the full
  // history, so totalTokens is the TRUE current context fill. The char/4
  // estimate is only a fallback until the first real reply lands.
  const lastUsage = [...messages].reverse().find((m) => m.usage && m.usage.totalTokens > 0)?.usage
  const estimated = messages.reduce((sum, m) => {
    let tokens = estimateTokens(m.content)
    if (m.thinking) tokens += estimateTokens(m.thinking)
    if (m.toolCallSummary) tokens += estimateTokens(m.toolCallSummary)
    tokens += 4 // role overhead
    return sum + tokens
  }, 0)
  const usedTokens = lastUsage ? lastUsage.totalTokens : estimated
  // "Real" = the model reported it. A provisional estimate the agent loop sets
  // before the first reply (so the bar reflects the system prompt + tools, not a
  // char/4 guess of the visible messages) carries `estimated:true` — show it, but
  // don't claim it's the model's exact count.
  const isReal = !!lastUsage && !lastUsage.estimated

  if (!activeConversationId || messages.length === 0) return null

  // Resolved real context window; fall back to the VRAM-safe default only while
  // the provider probe is still in flight (ctx not resolved yet).
  const maxTokens = ctx.contextWindow > 0 ? ctx.contextWindow : 16384

  const ratio = maxTokens > 0 ? usedTokens / maxTokens : 0
  const color = ratio > 0.8 ? 'text-red-400' : ratio > 0.5 ? 'text-amber-400' : 'text-gray-500'
  const barColor = ratio > 0.8 ? 'bg-red-500' : ratio > 0.5 ? 'bg-amber-500' : 'bg-gray-500'

  const formatK = (n: number) => n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n)

  const source = ctx.provider === 'lmstudio'
    ? "LM Studio loaded context"
    : ctx.provider === 'ollama'
      ? 'Ollama num_ctx'
      : 'model context'
  const title = isReal
    ? `Context: ${usedTokens.toLocaleString()} / ${maxTokens.toLocaleString()} tokens (${source}) — real, reported by the model (includes system prompt + tools + RAG)`
    : lastUsage
      ? `Estimated: ${usedTokens.toLocaleString()} / ${maxTokens.toLocaleString()} tokens (${source}) — includes the system prompt + tools; the exact count lands when the model replies`
      : `Estimated: ${usedTokens.toLocaleString()} / ${maxTokens.toLocaleString()} tokens (${source}) — estimate until the first reply`

  return (
    <div className={`flex items-center gap-1.5 px-2 py-1 ${color}`} title={title}>
      <div className="w-12 h-1 rounded-full bg-gray-200 dark:bg-white/10 overflow-hidden">
        <div
          className={`h-full rounded-full transition-all duration-300 ${barColor}`}
          style={{ width: `${Math.min(ratio * 100, 100)}%` }}
        />
      </div>
      <span className="text-[0.55rem] font-mono tabular-nums">
        {formatK(usedTokens)}/{formatK(maxTokens)}
      </span>
    </div>
  )
}
