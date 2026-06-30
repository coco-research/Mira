import { create } from 'zustand'
import { persist, createJSONStorage } from 'zustand/middleware'
import { v4 as uuid } from 'uuid'
import type { Conversation, Message, ChatArtifact } from '../types/chat'
import type { AgentBlock } from '../types/agent-mode'
import { idbStorage } from '../lib/idbStorage'
import { migrateBlockInPlace } from '../api/agents/block-helpers'
import { useGenerationStore } from './generationStore'
import { useRemoteStore } from './remoteStore'

/**
 * Rehydration migration for Phase 1 (v2.4.0) — wraps legacy
 * `AgentBlock.toolCall` (singular) into the new `toolCalls: AgentToolCall[]`
 * form. Idempotent: safe to run on already-migrated data. Leaves the legacy
 * field in place during a transition window so reads via either shape work.
 */
export function migratePersistedChat(state: any): any {
  if (!state || !Array.isArray(state.conversations)) return state
  for (const conv of state.conversations) {
    if (!conv || !Array.isArray(conv.messages)) continue
    for (const msg of conv.messages) {
      if (!msg || !Array.isArray(msg.agentBlocks)) continue
      for (const block of msg.agentBlocks as AgentBlock[]) {
        if (block) migrateBlockInPlace(block)
      }
    }
  }
  return state
}

interface ChatState {
  conversations: Conversation[]
  activeConversationId: string | null
  createConversation: (model: string, systemPrompt: string, mode?: 'lu' | 'codex' | 'openclaw' | 'remote') => string
  deleteConversation: (id: string) => void
  renameConversation: (id: string, title: string) => void
  setActiveConversation: (id: string | null) => void
  /** Toggle the active persona on/off for a specific chat — mirrors the
   *  mobile chat's `personaEnabled` flag so the user can suppress the
   *  persona's systemPrompt without changing the global Settings
   *  selection. */
  setConversationPersonaEnabled: (id: string, enabled: boolean) => void
  addMessage: (conversationId: string, message: Message) => void
  insertMessageBefore: (conversationId: string, beforeId: string, message: Message) => void
  updateMessageContent: (conversationId: string, messageId: string, content: string) => void
  updateMessageThinking: (conversationId: string, messageId: string, thinking: string) => void
  updateMessageUsage: (conversationId: string, messageId: string, usage: { promptTokens: number; completionTokens: number; totalTokens: number; estimated?: boolean }) => void
  updateMessageAgentBlocks: (conversationId: string, messageId: string, blocks: AgentBlock[]) => void
  updateMessageArtifacts: (conversationId: string, messageId: string, artifacts: ChatArtifact[]) => void
  deleteMessagesAfter: (conversationId: string, messageId: string) => void
  getActiveConversation: () => Conversation | undefined
  searchConversations: (query: string) => Conversation[]
}

export const useChatStore = create<ChatState>()(
  persist(
    (set, get) => ({
      conversations: [],
      activeConversationId: null,

      createConversation: (model, systemPrompt, mode) => {
        const id = uuid()
        // Auto-number remote chats so users can distinguish sessions in the sidebar
        let title: string
        // 'codex' is the internal back-compat mode id; the user-facing
        // default title is "Coding Agent".
        if (mode === 'codex') title = 'Coding Agent'
        else if (mode === 'remote') {
          const state = get()
          const nextNum = state.conversations.filter((c) => c.mode === 'remote').length + 1
          title = `Remote Chat ${nextNum}`
        } else title = 'New Chat'
        const conversation: Conversation = {
          id,
          title,
          messages: [],
          model,
          systemPrompt,
          mode: mode || 'lu',
          createdAt: Date.now(),
          updatedAt: Date.now(),
          // Per David's request: persona starts OFF by default on every
          // new conversation. The user has to flip it on explicitly via
          // the Plugins dropdown toggle. Without this, a globally
          // selected persona (e.g. "Devil's Advocate") would silently
          // hijack every new chat — including agent / codex tasks where
          // the persona conflicts with the autonomy contract.
          personaEnabled: false,
        }
        set((state) => ({
          conversations: [conversation, ...state.conversations],
          activeConversationId: id,
        }))
        return id
      },

      deleteConversation: (id) => {
        // Stop any in-flight turn (chat stream OR agent loop) for this chat
        // BEFORE dropping it, so deleting/closing a chat halts its activity
        // completely — no orphaned stream burning tokens / GPU after the chat
        // is gone (David 2026-06-15).
        try { useGenerationStore.getState().abortConversation(id) } catch { /* best-effort */ }
        // If this is the dispatched Remote chat, deleting/closing it must also
        // tear down the whole Remote session — stop the axum server AND kill
        // the Cloudflare tunnel/cloudflared process (David 2026-06-15: closing
        // the remote chat has to stop *everything*, not leave the server +
        // tunnel running in the background). undispatch() → stopServer() →
        // stop_remote_server (taskkill /T /F on the tunnel PID + abort serve).
        try {
          const remote = useRemoteStore.getState()
          if (remote.dispatchedConversationId === id) {
            void remote.undispatch()
          }
        } catch { /* best-effort */ }
        set((state) => ({
          conversations: state.conversations.filter((c) => c.id !== id),
          activeConversationId:
            state.activeConversationId === id ? null : state.activeConversationId,
        }))
      },

      renameConversation: (id, title) =>
        set((state) => ({
          conversations: state.conversations.map((c) =>
            c.id === id ? { ...c, title, updatedAt: Date.now() } : c
          ),
        })),

      setActiveConversation: (id) => set({ activeConversationId: id }),

      setConversationPersonaEnabled: (id, enabled) =>
        set((state) => ({
          conversations: state.conversations.map((c) =>
            c.id === id ? { ...c, personaEnabled: enabled } : c
          ),
        })),

      addMessage: (conversationId, message) =>
        set((state) => ({
          conversations: state.conversations.map((c) =>
            c.id === conversationId
              ? {
                ...c,
                messages: [...c.messages, message],
                updatedAt: Date.now(),
                title:
                  c.title === 'New Chat' && message.role === 'user'
                    ? message.content.slice(0, 50)
                    : c.title,
              }
              : c
          ),
        })),

      insertMessageBefore: (conversationId, beforeId, message) =>
        set((state) => ({
          conversations: state.conversations.map((c) => {
            if (c.id !== conversationId) return c
            const idx = c.messages.findIndex((m) => m.id === beforeId)
            if (idx < 0) return { ...c, messages: [...c.messages, message], updatedAt: Date.now() }
            const msgs = [...c.messages]
            msgs.splice(idx, 0, message)
            return { ...c, messages: msgs, updatedAt: Date.now() }
          }),
        })),

      updateMessageContent: (conversationId, messageId, content) =>
        set((state) => ({
          conversations: state.conversations.map((c) =>
            c.id === conversationId
              ? {
                ...c,
                messages: c.messages.map((m) => (m.id === messageId ? { ...m, content } : m)),
                updatedAt: Date.now(),
              }
              : c
          ),
        })),

      updateMessageThinking: (conversationId, messageId, thinking) =>
        set((state) => ({
          conversations: state.conversations.map((c) =>
            c.id === conversationId
              ? {
                ...c,
                messages: c.messages.map((m) => (m.id === messageId ? { ...m, thinking } : m)),
                updatedAt: Date.now(),
              }
              : c
          ),
        })),

      updateMessageUsage: (conversationId, messageId, usage) =>
        set((state) => ({
          conversations: state.conversations.map((c) =>
            c.id === conversationId
              ? {
                ...c,
                messages: c.messages.map((m) => (m.id === messageId ? { ...m, usage } : m)),
                updatedAt: Date.now(),
              }
              : c
          ),
        })),

      updateMessageAgentBlocks: (conversationId, messageId, agentBlocks) =>
        set((state) => ({
          conversations: state.conversations.map((c) =>
            c.id === conversationId
              ? {
                ...c,
                messages: c.messages.map((m) => (m.id === messageId ? { ...m, agentBlocks } : m)),
                updatedAt: Date.now(),
              }
              : c
          ),
        })),

      updateMessageArtifacts: (conversationId, messageId, artifacts) =>
        set((state) => ({
          conversations: state.conversations.map((c) =>
            c.id === conversationId
              ? {
                ...c,
                messages: c.messages.map((m) => (m.id === messageId ? { ...m, artifacts } : m)),
                updatedAt: Date.now(),
              }
              : c
          ),
        })),

      deleteMessagesAfter: (conversationId, messageId) =>
        set((state) => ({
          conversations: state.conversations.map((c) => {
            if (c.id !== conversationId) return c
            const idx = c.messages.findIndex((m) => m.id === messageId)
            if (idx < 0) return c
            return { ...c, messages: c.messages.slice(0, idx), updatedAt: Date.now() }
          }),
        })),

      getActiveConversation: () => {
        const { conversations, activeConversationId } = get()
        return conversations.find((c) => c.id === activeConversationId)
      },

      searchConversations: (query) => {
        const { conversations } = get()
        const lower = query.toLowerCase()
        return conversations.filter(
          (c) =>
            c.title.toLowerCase().includes(lower) ||
            c.messages.some((m) => m.content.toLowerCase().includes(lower))
        )
      },
    }),
    {
      name: 'chat-conversations',
      // IndexedDB (disk-backed, tens of GB) instead of localStorage's ~5 MB cap —
      // chat history with inline images needs the room. idbStorage migrates existing
      // localStorage data on first read. createJSONStorage wrap is still required
      // (zustand v5 PersistStorage; raw StateStorage → "[object Object]", see FIX-3).
      storage: createJSONStorage(() => idbStorage),
      // Phase 1 (v2.4.0) — rehydrate legacy singular `toolCall` into `toolCalls[]`.
      // Persisted shape is whatever was last written; migration runs on every load
      // and is idempotent, so version bumps are not required.
      merge: (persistedState: any, currentState: ChatState) => {
        const migrated = migratePersistedChat(persistedState)
        return { ...currentState, ...(migrated || {}) }
      },
    }
  )
)
