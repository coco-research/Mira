import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import type { SandboxLevel } from '../types/agent-mode'
import type { AgentWorkspace } from '../types/agent-workspace'

interface AgentModeState {
  // Per-conversation agent mode toggle
  agentModeActive: Record<string, boolean>

  // Per-conversation workspace pick (Sprint C #8 — Multi-Repo Agent).
  // Map keyed by conversation id; missing entry → no workspace chosen
  // yet. AgentWorkspaceDialog reads this on activate-time to know whether
  // it should pop up.
  workspaces: Record<string, AgentWorkspace>

  // Last folder the user picked from the "Use last folder" shortcut in
  // AgentWorkspaceDialog. Carries over across chats so the user doesn't
  // have to re-browse to the same repo every time. Updated by
  // setWorkspace() whenever a folder-kind workspace is saved.
  lastFolder: string | undefined

  // Settings
  sandboxLevel: SandboxLevel
  tutorialCompleted: boolean
  newChatHintDismissed: boolean

  // Actions
  toggleAgentMode: (conversationId: string) => void
  setAgentModeActive: (conversationId: string, active: boolean) => void
  setWorkspace: (conversationId: string, workspace: AgentWorkspace) => void
  clearWorkspace: (conversationId: string) => void
  setSandboxLevel: (level: SandboxLevel) => void
  setTutorialCompleted: () => void
  resetTutorial: () => void
  setNewChatHintDismissed: (dismissed: boolean) => void
  isActive: (conversationId: string) => boolean
}

export const useAgentModeStore = create<AgentModeState>()(
  persist(
    (set, get) => ({
      agentModeActive: {},
      workspaces: {},
      lastFolder: undefined,
      sandboxLevel: 'restricted',
      tutorialCompleted: false,
      newChatHintDismissed: false,

      toggleAgentMode: (conversationId) =>
        set((state) => ({
          agentModeActive: {
            ...state.agentModeActive,
            [conversationId]: !state.agentModeActive[conversationId],
          },
        })),

      setAgentModeActive: (conversationId, active) =>
        set((state) => ({
          agentModeActive: {
            ...state.agentModeActive,
            [conversationId]: active,
          },
        })),

      setWorkspace: (conversationId, workspace) =>
        set((state) => ({
          workspaces: {
            ...state.workspaces,
            [conversationId]: workspace,
          },
          // Folder-kind picks update the "last folder" shortcut so the
          // next AgentWorkspaceDialog can offer it. Sandbox picks don't
          // change the shortcut — that would erase a useful default.
          lastFolder:
            workspace.kind === 'folder' && workspace.path
              ? workspace.path
              : state.lastFolder,
        })),

      clearWorkspace: (conversationId) =>
        set((state) => {
          const next = { ...state.workspaces }
          delete next[conversationId]
          return { workspaces: next }
        }),

      setSandboxLevel: (level) => set({ sandboxLevel: level }),

      setTutorialCompleted: () => set({ tutorialCompleted: true }),

      resetTutorial: () => set({ tutorialCompleted: false }),

      setNewChatHintDismissed: (dismissed) => set({ newChatHintDismissed: dismissed }),

      isActive: (conversationId) => {
        return get().agentModeActive[conversationId] ?? false
      },
    }),
    { name: 'locally-uncensored-agent-mode' }
  )
)
