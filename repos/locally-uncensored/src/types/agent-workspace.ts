// Where an agent-mode chat operates on disk.
//
// 'sandbox' → bridge resolves relative paths under
// `~/agent-workspace/<chat-slug>/`. Isolated, throwaway, safe.
//
// 'folder'  → the user picked a real directory (via Bridge `pick_folder`).
// Relative paths land under that path; the agent can read + modify the
// user's actual repo. Same wire shape as Codex.
export type AgentWorkspaceKind = 'sandbox' | 'folder'

export interface AgentWorkspace {
  kind: AgentWorkspaceKind
  /** Absolute path. Set when kind === 'folder', undefined for sandbox. */
  path?: string
  /**
   * Additional absolute repo paths the agent can read/write via *absolute*
   * paths. Tool resolution still anchors relative paths to `path`; extras
   * are listed in the system prompt so the model can address them by
   * absolute path. Use case: "sync this API in repo-A with the client in
   * repo-B" — pick repo-A as the primary, add repo-B as an extra.
   */
  extraPaths?: string[]
}

export const SANDBOX_WORKSPACE: AgentWorkspace = { kind: 'sandbox' }
