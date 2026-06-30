/**
 * Sprint B #5 — Typed wrappers for `git` and `gh`.
 *
 * Pure helpers for assembling commands + parsing the porcelain output of
 * `git status` and the one-line `git log` format. The MCP executors call
 * shell_execute under the hood but expose this surface to the model so a
 * "make me a PR" turn is a single typed call instead of a juggled shell
 * pipeline with bespoke error messages on every step.
 */

export interface GitStatusEntry {
  /** Two-letter porcelain code: `??` for untracked, ` M` for unstaged-modified, `M ` for staged-modified, etc. */
  code: string
  path: string
  /** Convenience flag: did the file enter the index? */
  staged: boolean
}

export interface GitStatusResult {
  branch: string | null
  ahead: number
  behind: number
  entries: GitStatusEntry[]
  /** True iff the working tree has no uncommitted changes (staged or unstaged). */
  clean: boolean
}

/**
 * Parses `git status --porcelain=2 --branch` output. Falls back gracefully
 * when the user runs older git that lacks `--porcelain=2`; in that case
 * `branch` stays null and only the entries are populated.
 */
export function parseGitStatus(raw: string): GitStatusResult {
  const lines = raw.split('\n')
  let branch: string | null = null
  let ahead = 0
  let behind = 0
  const entries: GitStatusEntry[] = []
  for (const line of lines) {
    if (!line) continue
    if (line.startsWith('# branch.head ')) {
      branch = line.slice('# branch.head '.length).trim()
      if (branch === '(detached)') branch = null
      continue
    }
    if (line.startsWith('# branch.ab ')) {
      const m = line.match(/\+(\d+)\s+-(\d+)/)
      if (m) {
        ahead = parseInt(m[1], 10)
        behind = parseInt(m[2], 10)
      }
      continue
    }
    if (line.startsWith('#')) continue
    // Porcelain v2 entries start with 1/2/u/?. Cheap parse: extract path
    // as the trailing whitespace-separated token. Rename entries get the
    // new path; we drop the old name to keep the model output small.
    if (line.startsWith('? ')) {
      entries.push({ code: '??', path: line.slice(2).trim(), staged: false })
      continue
    }
    if (line.startsWith('1 ') || line.startsWith('2 ')) {
      // Format: `1 XY <sub> ... <path>` where XY are status chars.
      const parts = line.split(' ')
      if (parts.length >= 9) {
        const xy = parts[1] || '  '
        const path = parts.slice(8).join(' ')
        const staged = xy[0] !== '.' && xy[0] !== ' '
        entries.push({ code: xy, path, staged })
      }
      continue
    }
    if (line.startsWith('u ')) {
      // Unmerged path — treat as a conflict the model must resolve.
      const parts = line.split(' ')
      const path = parts[parts.length - 1]
      entries.push({ code: 'UU', path, staged: false })
    }
  }
  return { branch, ahead, behind, entries, clean: entries.length === 0 }
}

export function renderGitStatus(r: GitStatusResult): string {
  if (!r.entries.length && r.branch) {
    return `On branch ${r.branch}. Working tree clean.`
  }
  const head = r.branch
    ? `On branch ${r.branch}${r.ahead || r.behind ? ` (ahead ${r.ahead}, behind ${r.behind})` : ''}.`
    : 'Detached HEAD.'
  const lines = r.entries.map((e) => `  ${e.code} ${e.path}`)
  return `${head}\n${lines.join('\n')}`
}

export interface GitLogEntry {
  sha: string
  subject: string
}

export function parseGitLog(raw: string): GitLogEntry[] {
  const out: GitLogEntry[] = []
  for (const line of raw.split('\n')) {
    if (!line) continue
    const m = line.match(/^([0-9a-f]{7,40})\s+(.+)$/i)
    if (m) out.push({ sha: m[1], subject: m[2] })
  }
  return out
}

/**
 * Shell-quotes a string for POSIX shells. We use single quotes + literal
 * escaping for embedded single quotes — bullet-proof against most input,
 * including the model emitting backticks or `$()` it shouldn't.
 */
export function shellQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`
}

export interface GitCommitArgs {
  message: string
  files?: string[]
  /** Stage every change before committing. Mutually exclusive with files. */
  allTracked?: boolean
}

export function buildGitCommitCommand(args: GitCommitArgs): string {
  if (!args.message?.trim()) return ''
  const stage = args.allTracked
    ? 'git add -A'
    : args.files?.length
      ? `git add -- ${args.files.map(shellQuote).join(' ')}`
      : ''
  const commit = `git commit -m ${shellQuote(args.message)}`
  return stage ? `${stage} && ${commit}` : commit
}

export interface GhPrCreateArgs {
  title: string
  body: string
  base?: string
}

export function buildGhPrCreateCommand(args: GhPrCreateArgs): string {
  if (!args.title?.trim()) return ''
  const flags = [
    `--title ${shellQuote(args.title)}`,
    `--body ${shellQuote(args.body ?? '')}`,
  ]
  if (args.base) flags.push(`--base ${shellQuote(args.base)}`)
  return `gh pr create ${flags.join(' ')}`
}
