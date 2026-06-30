import { backendCall } from '../backend'

export interface BgTaskStatus {
  id: string
  command: string
  cwd: string | null
  started_at: number
  finished_at: number | null
  exit_code: number | null
  running: boolean
  cancelled: boolean
  output_tail: string
}

export interface BgTaskListResult {
  tasks: BgTaskStatus[]
}

/** Starts a long-running shell command in the bridge. Returns the new task id. */
export async function bgStart(input: {
  command: string
  cwd?: string
  shell?: string
}): Promise<{ id: string }> {
  if (!input.command?.trim()) throw new Error('command is required')
  // The Rust bg_tasks commands take a SINGLE `args: serde_json::Value` param
  // (manually deserialized into StartArgs/IdArgs) — unlike `shell_execute`,
  // which uses flat params. So every payload MUST be wrapped in `{ args: … }`.
  // Sending the fields top-level (as the flat convention does) makes Tauri
  // reject the call with "missing required key args" — which silently broke
  // shell_execute_background / shell_task_status / _kill / _list for every
  // model (confirmed live 2026-06-02 via the Tauri bridge).
  return backendCall<{ id: string }>('shell_task_start', {
    args: {
      command: input.command,
      cwd: input.cwd,
      shell: input.shell,
    },
  })
}

export async function bgStatus(id: string): Promise<BgTaskStatus> {
  return backendCall<BgTaskStatus>('shell_task_status', { args: { id } })
}

export async function bgKill(id: string): Promise<{ ok: boolean; cancelled: boolean }> {
  return backendCall<{ ok: boolean; cancelled: boolean }>('shell_task_kill', { args: { id } })
}

export async function bgList(): Promise<BgTaskListResult> {
  return backendCall<BgTaskListResult>('shell_task_list', { args: {} })
}

/** Renders a status payload as a one-line summary for the model / UI. */
export function renderBgStatusOneLine(s: BgTaskStatus): string {
  const phase = s.running
    ? 'running'
    : s.cancelled
      ? 'cancelled'
      : s.exit_code === 0
        ? 'ok'
        : `exit ${s.exit_code ?? '?'}`
  const elapsed = s.finished_at
    ? `${s.finished_at - s.started_at}s`
    : `${Math.max(0, Math.floor(Date.now() / 1000) - s.started_at)}s`
  return `[${s.id.slice(0, 8)}] ${phase} (${elapsed}) — ${s.command}`
}
