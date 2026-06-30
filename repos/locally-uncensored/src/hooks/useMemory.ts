/**
 * useMemory — Hook for memory operations including LLM-based auto-extraction.
 *
 * Fires a separate inference call to analyze conversation exchanges and
 * extract memorable information. Errors are caught silently — extraction
 * failures must never disrupt the chat experience.
 */

import { useCallback } from 'react'
import { useMemoryStore } from '../stores/memoryStore'
import { useModelStore } from '../stores/modelStore'
import { useProviderStore } from '../stores/providerStore'
import { getProviderForModel } from '../api/providers'
import {
  buildExtractionPrompt,
  parseExtractionResponse,
  buildResolutionPrompt,
  parseResolutionResponse,
  type ExtractedMemory,
  type SimilarExisting,
} from '../lib/memory-extraction'
import { generateEmbeddings, cosineSimilarity } from '../api/rag'
import { loadVectors } from '../lib/memoryEmbedDB'
import type { MemoryFile } from '../types/agent-mode'

// Rate limit: only extract every Nth turn to reduce cost
let _extractCounter = 0
const EXTRACT_EVERY_N = 3
const MIN_RESPONSE_LENGTH = 100

// ── Write-decision similarity bands (Feature FF) ──────────────────
// Cosine of the new fact's embedding against the most-similar SAME-TYPE
// existing memory decides the write path:
//   sim <  ADD_THRESHOLD   → clearly new → addMemory (no extra LLM call)
//   ADD..NOOP (the "merge band") → ambiguous → one temp:0.1 resolution call
//   sim >= NOOP_THRESHOLD   → already captured → skip (no LLM call, no write)
// Thresholds are first-pass; need live MV3/MV4 validation before "tuned".
const ADD_THRESHOLD = 0.6
const NOOP_THRESHOLD = 0.92
// How many similar existing memories to show the resolver.
const RESOLUTION_TOP_K = 3

/**
 * Pure extraction routine — safe to call from anywhere (hooks, Tauri listeners,
 * background jobs). Fire-and-forget: never throws, errors are swallowed.
 *
 * Used by:
 *  - useMemory().extractAndSave (LU chat)
 *  - useAgentChat (agent loop)
 *  - useCodex (codex loop)
 *  - AppShell.tsx remote-chat-message listener (Remote chats)
 */
export async function extractMemoriesFromPair(
  userMessage: string,
  assistantResponse: string,
  conversationId: string
): Promise<void> {
  try {
    const { activeModel } = useModelStore.getState()
    if (!activeModel) return

    const memState = useMemoryStore.getState()
    if (!memState.settings.autoExtractEnabled) return

    // Skip short responses (not enough signal to extract)
    if (assistantResponse.length < MIN_RESPONSE_LENGTH) return

    // Rate limit: only extract every Nth turn
    _extractCounter++
    if (_extractCounter % EXTRACT_EVERY_N !== 0) return

    // Warn-check: if cloud provider, check if user has opted in
    const providerState = useProviderStore.getState()
    const isCloud = (providerState.providers.openai.enabled && !providerState.providers.openai.isLocal) ||
      providerState.providers.anthropic.enabled
    if (isCloud && !memState.settings.autoExtractInAllModes) return

    // Build summary of existing memories to prevent duplicates
    const existingSummary = memState.entries
      .slice(-20)
      .map(e => `- [${e.type}] ${e.title}`)
      .join('\n')

    const messages = buildExtractionPrompt(userMessage, assistantResponse, existingSummary)

    // Use active provider for extraction call
    const { provider, modelId } = getProviderForModel(activeModel)

    // Collect full response via streaming
    let fullResponse = ''
    const stream = provider.chatStream(modelId, messages, {
      temperature: 0.1,
      maxTokens: 500,
    })

    for await (const chunk of stream) {
      if (chunk.content) fullResponse += chunk.content
      if (chunk.done) break
    }

    // Parse and save — each memory goes through embedding-based write-decision
    // resolution (ADD / UPDATE / NOOP) instead of a blind addMemory.
    const result = parseExtractionResponse(fullResponse)
    if (result.shouldSave) {
      for (const memory of result.memories) {
        // Serial per-memory so the second (resolution) LLM call is bounded and
        // we don't fire N concurrent inferences. Each is wrapped so one bad
        // memory never aborts the rest.
        try {
          await resolveAndSaveMemory(memory, conversationId)
        } catch {
          // Per-memory failure → fall back to a plain add so the fact isn't lost.
          memState.addMemory({
            type: memory.type,
            title: memory.title,
            description: memory.description,
            content: memory.content,
            tags: memory.tags,
            source: conversationId,
          })
        }
      }
    }
  } catch {
    // Extraction failures are non-critical — silently swallowed
  }
}

/**
 * Resolve a single freshly-extracted memory against existing SAME-TYPE
 * memories using embedding similarity, then write it via the right path:
 *
 *   - sim < ADD_THRESHOLD          → addMemory (today's behavior)
 *   - ADD_THRESHOLD ≤ sim < NOOP   → "merge band": one temp:0.1 resolution
 *                                    call → applyWriteDecision (ADD/UPDATE/NOOP)
 *   - sim ≥ NOOP_THRESHOLD         → near-duplicate → skip (NO LLM call)
 *
 * Fire-and-forget contract: any embedding/LLM failure falls back to a plain
 * addMemory so a fact is never silently dropped. Never blocks the chat turn.
 */
async function resolveAndSaveMemory(memory: ExtractedMemory, conversationId: string): Promise<void> {
  const memState = useMemoryStore.getState()
  const addPlain = (): string =>
    memState.addMemory({
      type: memory.type,
      title: memory.title,
      description: memory.description,
      content: memory.content,
      tags: memory.tags,
      source: conversationId,
    })

  // Same-type, non-stale existing memories are the only merge candidates —
  // a "user" fact never merges into a "reference", etc.
  const sameType: MemoryFile[] = memState.entries.filter(
    (e) => e.type === memory.type && e.stale !== true,
  )
  if (sameType.length === 0) {
    addPlain()
    return
  }

  // Embed the new fact (title + content, mirroring the store's embedText).
  let newVec: number[] | null = null
  try {
    const [vec] = await generateEmbeddings([`${memory.title}\n${memory.content}`], 'nomic-embed-text')
    if (vec && vec.length > 0) newVec = vec
  } catch {
    // Ollama unreachable → can't compute similarity → just add (offline-safe).
  }
  if (!newVec) {
    addPlain()
    return
  }

  // Hydrate vectors for same-type candidates and find the most similar one.
  const vecMap = await loadVectors(sameType.map((e) => e.id))
  let bestSim = -1
  let bestEntry: MemoryFile | null = null
  const scored: Array<{ entry: MemoryFile; sim: number }> = []
  for (const e of sameType) {
    const rec = vecMap.get(e.id)
    if (!rec || rec.dim !== newVec.length) continue
    const sim = cosineSimilarity(newVec, rec.vector)
    scored.push({ entry: e, sim })
    if (sim > bestSim) {
      bestSim = sim
      bestEntry = e
    }
  }

  // No comparable vectors yet (candidates not embedded) → treat as new.
  if (!bestEntry || bestSim < 0) {
    addPlain()
    return
  }

  // Near-duplicate → already captured → skip entirely (NO second LLM call).
  if (bestSim >= NOOP_THRESHOLD) return

  // Clearly distinct → add as new (NO second LLM call).
  if (bestSim < ADD_THRESHOLD) {
    addPlain()
    return
  }

  // ── Merge band: ambiguous. Ask the LLM to resolve. ────────────
  const topK: SimilarExisting[] = scored
    .sort((a, b) => b.sim - a.sim)
    .slice(0, RESOLUTION_TOP_K)
    .map(({ entry }) => ({ id: entry.id, title: entry.title, content: entry.content }))

  // Add the candidate first so an UPDATE can mark it superseded and a parse
  // failure (→ ADD) still keeps the fact. NOOP removes it again below.
  const newId = addPlain()

  let decision
  try {
    const { activeModel } = useModelStore.getState()
    if (!activeModel) return // candidate already added; leave as ADD
    const { provider, modelId } = getProviderForModel(activeModel)
    const messages = buildResolutionPrompt(
      { title: memory.title, content: memory.content },
      topK,
    )
    let full = ''
    const stream = provider.chatStream(modelId, messages, { temperature: 0.1, maxTokens: 300 })
    for await (const chunk of stream) {
      if (chunk.content) full += chunk.content
      if (chunk.done) break
    }
    decision = parseResolutionResponse(full, topK.map((t) => t.id))
  } catch {
    // Resolution call failed → leave the candidate as a plain ADD.
    return
  }

  if (decision.action === 'ADD') {
    // Already added as `newId` — nothing more to do.
    return
  }
  if (decision.action === 'NOOP') {
    // Duplicate after all → undo the speculative add.
    if (newId) useMemoryStore.getState().removeMemory(newId)
    return
  }
  // UPDATE: merge into the target, mark the speculative candidate superseded.
  useMemoryStore.getState().applyWriteDecision(decision, { newId: newId || undefined })
}

export function useMemory() {
  /**
   * Fire-and-forget extraction: asks the active LLM to analyze a conversation
   * exchange and save any extracted memories. Rate-limited to every 3rd turn
   * and skips short responses.
   */
  const extractAndSave = useCallback(extractMemoriesFromPair, [])

  return { extractAndSave }
}
