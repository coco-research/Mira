import { create } from 'zustand'
import { v4 as uuid } from 'uuid'

export interface StagedChange {
  /** Stable id assigned at stage-time so the UI can key + remove safely. */
  id: string
  /** Path the model called `file_write` with (as the model wrote it — may be relative). */
  path: string
  /**
   * Absolute path resolved against the run's workspace AT STAGE TIME. Apply
   * happens after the run ends, when useCodex's finally has cleared the active
   * chat/workspace context — so a relative `path` would route to
   * agent-workspace/default/ instead of the project folder the agent wrote into.
   * Writing this captured absolute path makes the approved diff land exactly
   * where it should. Falls back to `path` (already absolute / no workspace set).
   */
  resolvedPath?: string
  /** Full file content before the write — empty string when the target didn't exist. */
  oldContent: string
  /** Full file content the model wants to write. */
  newContent: string
  /** Pre-computed unified diff for snappy rendering — caller decides format. */
  diff: string
  /** Wall-clock when the model staged this change. */
  stagedAt: number
}

interface StagedChangesState {
  /** Per-conversation queue. Cleared on apply-all / reject-all / chat reset. */
  byChat: Record<string, StagedChange[]>
  /** Adds a change, returns the assigned id. Identical paths overwrite the prior entry — the model usually means the latest write to win. */
  stage: (
    chatId: string,
    change: Omit<StagedChange, 'id' | 'stagedAt'>,
  ) => string
  /** Removes a single change from the queue. */
  remove: (chatId: string, id: string) => void
  /** Clears all staged changes for a chat. */
  clear: (chatId: string) => void
  /** Returns the queue for a chat (empty array if none). */
  list: (chatId: string) => StagedChange[]
  /** Looks up a single change by id. */
  get: (chatId: string, id: string) => StagedChange | undefined
}

export const useStagedChangesStore = create<StagedChangesState>()((set, get) => ({
  byChat: {},

  stage: (chatId, change) => {
    const id = uuid()
    set((state) => {
      const prev = state.byChat[chatId] ?? []
      // Same path — replace, don't dupe. The diff carries the latest intent.
      const without = prev.filter((c) => c.path !== change.path)
      return {
        byChat: {
          ...state.byChat,
          [chatId]: [
            ...without,
            { ...change, id, stagedAt: Date.now() },
          ],
        },
      }
    })
    return id
  },

  remove: (chatId, id) =>
    set((state) => {
      const prev = state.byChat[chatId]
      if (!prev) return state
      const next = prev.filter((c) => c.id !== id)
      const byChat = { ...state.byChat }
      if (next.length === 0) {
        delete byChat[chatId]
      } else {
        byChat[chatId] = next
      }
      return { byChat }
    }),

  clear: (chatId) =>
    set((state) => {
      if (!state.byChat[chatId]) return state
      const byChat = { ...state.byChat }
      delete byChat[chatId]
      return { byChat }
    }),

  list: (chatId) => get().byChat[chatId] ?? [],

  get: (chatId, id) => (get().byChat[chatId] ?? []).find((c) => c.id === id),
}))
