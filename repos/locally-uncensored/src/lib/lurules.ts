// `.lurules` — per-repo Codex configuration, table-stakes for any 2026
// coding agent (Cursor → `.cursorrules`, Cline → `.clinerules`, Claude
// Code → `CLAUDE.md` hooks, Continue → `.continue/config.yaml`).
//
// Our shape is the minimum that actually delivers value: a plain-text
// file at the working-dir root whose contents get appended to the Codex
// system prompt verbatim. The agent reads it as project conventions —
// "use 2-space indent", "never touch src/generated", "always run pnpm
// typecheck after edits", etc.
//
// We deliberately don't parse a structured format yet: the bigger
// payoff is just letting the user write prose. Tool-allow-lists and
// model-pinning live in Settings; bringing them into the rules file is
// a future step once we have actual usage signal.
//
// Caveats:
// - We only look at the workDir root, not parents. A monorepo can put
//   one file at the repo root and it applies to every per-chat
//   workspace beneath it via the user's own symlink / shared rules
//   directory (`.lurules → ../.lurules`).
// - We cap the file at 10 kB. A 100 kB rules file would dominate the
//   context window of a 4k/8k local model and is almost always a sign
//   the user wants a README, not agent guidance.

export const LURULES_FILENAME = '.lurules'
export const LURULES_MAX_BYTES = 10 * 1024

export interface LoadedRules {
  /** Absolute path the rules came from. */
  path: string
  /** File contents, trimmed and length-capped. */
  text: string
  /** True when the source file exceeded LURULES_MAX_BYTES and was truncated. */
  truncated: boolean
}

export interface RulesReader {
  read(path: string): Promise<string | null>
}

/**
 * Try to load `.lurules` from `workDir`. Returns null when the file
 * doesn't exist or the reader errored — both treated identically so the
 * caller doesn't need to know whether the failure was "no file" vs.
 * "filesystem permission denied".
 */
export async function loadLurules(
  workDir: string,
  reader: RulesReader,
): Promise<LoadedRules | null> {
  if (!workDir) return null
  const path = joinPath(workDir, LURULES_FILENAME)
  let raw: string | null
  try {
    raw = await reader.read(path)
  } catch {
    return null
  }
  if (raw === null || raw === undefined) return null
  const trimmed = raw.trim()
  if (trimmed.length === 0) return null

  const truncated = trimmed.length > LURULES_MAX_BYTES
  const text = truncated ? trimmed.slice(0, LURULES_MAX_BYTES) : trimmed
  return { path, text, truncated }
}

/**
 * Wrap loaded rules in a system-prompt section that's clearly fenced
 * off from the agent's instructions. Returns the empty string for a
 * null input so callers can `prompt += renderRulesSection(rules)`
 * unconditionally.
 */
export function renderRulesSection(rules: LoadedRules | null): string {
  if (!rules) return ''
  const truncatedNotice = rules.truncated
    ? `\n[truncated to ${LURULES_MAX_BYTES} bytes — split the file if you need more]`
    : ''
  return [
    '',
    '─── Project rules from .lurules ────────────────────────────',
    'These are project conventions defined by the user. Follow them',
    'unless the user explicitly overrides one in this turn.',
    '',
    rules.text,
    truncatedNotice,
    '─── end .lurules ───────────────────────────────────────────',
    '',
  ].join('\n')
}

function joinPath(dir: string, name: string): string {
  // Cross-platform join without bringing node:path into the client bundle.
  const slash = dir.includes('\\') && !dir.includes('/') ? '\\' : '/'
  const trimmed = dir.replace(/[\\/]+$/, '')
  return `${trimmed}${slash}${name}`
}
