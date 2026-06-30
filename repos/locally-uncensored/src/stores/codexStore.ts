import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import type { ChatMode, CodexThread, CodexEvent, FileTreeNode } from '../types/codex'

interface CodexState {
  chatMode: ChatMode
  threads: Record<string, CodexThread>
  workingDirectory: string
  fileTree: FileTreeNode[]
  /**
   * Bump counter — incremented every time a Codex run mutates the working
   * directory (file_write, file_change, terminal commands that can modify
   * files). FileTree subscribes to this and reloads when it changes, so
   * new/deleted files appear without a manual refresh.
   */
  fileTreeVersion: number

  setChatMode: (mode: ChatMode) => void
  setWorkingDirectory: (dir: string) => void
  setFileTree: (tree: FileTreeNode[]) => void
  bumpFileTreeVersion: () => void

  getThread: (conversationId: string) => CodexThread | undefined
  initThread: (conversationId: string, workingDir: string) => string
  addEvent: (conversationId: string, event: CodexEvent) => void
  setThreadStatus: (conversationId: string, status: CodexThread['status']) => void
}

export const useCodexStore = create<CodexState>()(
  persist(
    (set, get) => ({
      chatMode: 'lu',
      threads: {},
      workingDirectory: '',
      fileTree: [],
      fileTreeVersion: 0,

      setChatMode: (mode) => set({ chatMode: mode }),
      setWorkingDirectory: (dir) => set({ workingDirectory: dir }),
      setFileTree: (tree) => set({ fileTree: tree }),
      bumpFileTreeVersion: () => set((state) => ({ fileTreeVersion: state.fileTreeVersion + 1 })),

      getThread: (conversationId) => get().threads[conversationId],

      initThread: (conversationId, workingDir) => {
        const id = `codex-${Date.now()}`
        set((state) => ({
          threads: {
            ...state.threads,
            [conversationId]: {
              id,
              conversationId,
              events: [],
              status: 'idle',
              workingDirectory: workingDir,
            },
          },
        }))
        return id
      },

      addEvent: (conversationId, event) =>
        set((state) => {
          const thread = state.threads[conversationId]
          if (!thread) return state
          // Auto-bump fileTreeVersion for events that can mutate the working
          // directory. FileTree watches this and re-reads the directory.
          const mutatesFs =
            event.type === 'file_change' ||
            event.type === 'terminal_output' // shell/code execution can touch files
          return {
            threads: {
              ...state.threads,
              [conversationId]: {
                ...thread,
                events: [...thread.events, event],
              },
            },
            fileTreeVersion: mutatesFs ? state.fileTreeVersion + 1 : state.fileTreeVersion,
          }
        }),

      setThreadStatus: (conversationId, status) =>
        set((state) => {
          const thread = state.threads[conversationId]
          if (!thread) return state
          return {
            threads: {
              ...state.threads,
              [conversationId]: { ...thread, status },
            },
          }
        }),
    }),
    {
      // Persist key kept as 'locally-uncensored-codex' for storage
      // back-compat — renaming it would orphan every existing user's
      // coding working-directory. Internal id only; user-facing label is
      // "Coding Agent".
      name: 'locally-uncensored-codex',
      // chatMode is intentionally NOT persisted: newcomers should always land in
      // the Chat tab on startup, not whatever tab they left off in. If a user
      // wants to stay in the Coding Agent, they pick it from the sidebar
      // each session. workingDirectory still persists so it remembers the
      // last project path.
      partialize: (state) => ({
        workingDirectory: state.workingDirectory,
      }),
      // Existing installs have a persisted `chatMode: 'codex'` (or similar) in
      // localStorage from v2.3.8 and earlier. partialize only affects writes,
      // so rehydration would still restore the old value until the user next
      // switches tabs. Force it back to the default on every rehydrate so the
      // fix takes effect on existing users too, not just fresh installs.
      onRehydrateStorage: () => (state) => {
        if (state) state.chatMode = 'lu'
      },
    }
  )
)
