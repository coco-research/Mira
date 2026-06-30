/**
 * Effective context-window resolution — single source of truth so the value we
 * SEND to the model (Ollama `num_ctx`) and the value we DISPLAY (TokenCounter
 * denominator) can never disagree (David 2026-06-05: "muss immer stimmen").
 *
 * Leaf module — imports NOTHING from api/* so it can be used by both the
 * provider layer and the UI without an import cycle.
 *
 * Why a cap and not the model's full trained context:
 *  - Ollama allocates the KV cache for `num_ctx` at load time. A model may
 *    advertise a 128k–256k context, but allocating that much KV cache OOMs
 *    consumer GPUs instantly. Ollama's own default (2048) is the opposite
 *    failure: it silently truncates every real chat.
 *  - 16384 is the balance: 8× Ollama's default (no silent truncation for
 *    normal chats/RAG), yet a modest KV footprint that fits a 12 GB card.
 *  - Power users who know their VRAM set `contextWindowOverride` in Settings;
 *    that wins and can go all the way to the model's real maximum.
 */
export const DEFAULT_CONTEXT_CAP = 16384

/**
 * @param modelMax   the model's real/trained context length (0/undefined = unknown)
 * @param override   user's explicit contextWindowOverride (0 = no override)
 * @returns the context window to actually use — never exceeds the model's real
 *          max (when known), never silently sits at Ollama's 2048 default.
 */
export function effectiveContextWindow(modelMax: number | undefined, override?: number): number {
  if (override && override > 0) return override
  const max = modelMax && modelMax > 0 ? modelMax : DEFAULT_CONTEXT_CAP
  return Math.min(max, DEFAULT_CONTEXT_CAP)
}
