// NOTE: the 'codex' value is kept as a stable internal id for storage
// back-compat (zustand persist key 'locally-uncensored-codex' + per-chat
// mode tag). It is an invisible identifier — the user-facing label is
// "Coding Agent" (see CodexView / Sidebar). Renaming it would wipe existing
// users' coding chats + working-dir on upgrade.
export type ChatMode = 'lu' | 'codex' | 'openclaw' | 'remote'

export type CodexEventType = 'instruction' | 'file_change' | 'terminal_output' | 'reasoning' | 'error' | 'done'

export interface CodexEvent {
  id: string
  type: CodexEventType
  content: string
  timestamp: number
  filePath?: string
  diff?: string
}

export interface CodexThread {
  id: string
  conversationId: string
  events: CodexEvent[]
  status: 'idle' | 'running' | 'error'
  workingDirectory: string
}

export interface FileTreeNode {
  name: string
  path: string
  isDirectory: boolean
  size?: number
  children?: FileTreeNode[]
}
