import { create } from 'zustand'

/**
 * Model-Picker (v2.5.3, David 2026-06-10): before the VRAM swap of an
 * image/video generation, LU itself (not the LLM) shows the installed
 * ComfyUI models inside the tool call so the user can pick one — with a
 * save icon to persist the choice for future prompts ("für nächste Prompts
 * übernommen"). This store is the rendezvous between the tool executor
 * (which awaits `request()`) and the ModelPickerCard UI (which resolves it
 * via `choose()` / `cancel()`). Same promise-gate pattern as the agent
 * approval queue in useAgentChat.
 *
 * Not persisted — a pending pick never survives a reload (the generation it
 * gates is gone too). The SAVED preference lives in settingsStore (v9 keys).
 */

export type ModelPickKind = 'image' | 'video-t2v' | 'video-i2v'

export interface ModelPickChoice {
  model: string
  /** True = persist as the preferred model for this kind (the save icon). */
  save: boolean
}

export interface ModelPickRequest {
  id: string
  kind: ModelPickKind
  /** Installed, kind-eligible ComfyUI model names (decide-phase filtering). */
  models: string[]
  /** Pre-selected entry (saved preference fallback or first installed). */
  current: string
}

/** Auto-continue with the pre-selection when nobody clicks — keeps the
 *  pre-picker behaviour ("it just generates") for AFK users. The card shows
 *  a live countdown and fires slightly earlier with the user's on-screen
 *  selection; this store timeout is the headless fallback. */
export const MODEL_PICK_TIMEOUT_MS = 90_000

interface ModelPickState {
  pending: ModelPickRequest | null
  /** Executor side: returns the user's choice, or null on timeout/cancel
   *  (caller falls back to `current`). Serializes overlapping requests. */
  request: (kind: ModelPickKind, models: string[], current: string) => Promise<ModelPickChoice | null>
  /** UI side: resolve the pending request with a concrete pick. */
  choose: (choice: ModelPickChoice) => void
  /** UI side / timeout: resolve with null (use the pre-selection). */
  cancel: () => void
}

let resolver: ((choice: ModelPickChoice | null) => void) | null = null
let timeoutHandle: ReturnType<typeof setTimeout> | null = null
let seq = 0

export const useModelPickStore = create<ModelPickState>()((set, get) => {
  const settle = (choice: ModelPickChoice | null) => {
    if (!get().pending) return
    if (timeoutHandle) { clearTimeout(timeoutHandle); timeoutHandle = null }
    const r = resolver
    resolver = null
    set({ pending: null })
    r?.(choice)
  }

  return {
    pending: null,

    request: async (kind, models, current) => {
      // Serialize: a second generation's pick waits until the first resolves
      // (tool calls are effectively sequential anyway; this is a safety net).
      while (get().pending) {
        await new Promise((r) => setTimeout(r, 250))
      }
      return new Promise<ModelPickChoice | null>((resolve) => {
        resolver = resolve
        const req: ModelPickRequest = { id: `pick-${++seq}`, kind, models, current }
        set({ pending: req })
        timeoutHandle = setTimeout(() => {
          // Headless fallback — the card usually auto-continues first.
          if (get().pending?.id === req.id) settle(null)
        }, MODEL_PICK_TIMEOUT_MS)
      })
    },

    choose: (choice) => settle(choice),
    cancel: () => settle(null),
  }
})
