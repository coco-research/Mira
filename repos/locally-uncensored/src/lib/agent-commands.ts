/**
 * Agent slash commands (v2.5.3, David 2026-06-11: "10 funktionelle slash
 * commands für den agent mode, guck dir die besten von claude code ab").
 *
 * Each command is a high-quality prompt template modeled on Claude Code's most
 * popular commands (/review, /commit, /test, /fix, /explain, /refactor, /docs,
 * /security, /optimize, /init). A slash command is shorthand for an AGENT task:
 * the chat hook expands it to the full instruction below, enables agent mode
 * for that conversation, and runs it through the normal agent executor (full
 * tool catalog — file_*, shell_execute, web_*, …). So the templates are written
 * for an agent that ACTS via tools, not one that describes.
 *
 * Pure data + pure functions here — no React, no side effects — so it unit-tests
 * cleanly and the ChatInput autocomplete + the useChat router share one source.
 */

export interface AgentCommand {
  /** Command word without the leading slash, e.g. "review". */
  name: string
  /** One-line summary shown in the autocomplete dropdown. */
  summary: string
  /** Argument hint shown after the name, e.g. "[file | \"changes\"]". */
  argHint?: string
  /** True when the command is read-only (no file/shell mutations). */
  readOnly?: boolean
  /** Expand to the full agent instruction. `args` is the trimmed text after the command. */
  build: (args: string) => string
}

/** Shared closing line so every command nudges the agent to act, not narrate. */
const ACT = 'Use your tools to do this for real — do not just describe the steps. Be concise in text; the work happens in tool calls. Reply in the user\'s language.'

export const AGENT_COMMANDS: AgentCommand[] = [
  {
    name: 'review',
    summary: 'Review code for bugs, security and style',
    argHint: '[file | "changes"]',
    readOnly: true,
    build: (a) => {
      const target = a.trim() || 'the current uncommitted changes (use shell_execute "git diff" / "git status"; if not a git repo, review the most relevant source files)'
      return `Do a focused code review of ${target}. Read the actual code with file_read / file_list first — never review from memory. Report findings grouped by severity (Critical / Major / Minor), each with the file:line, what's wrong, and a concrete fix. Cover correctness/bugs, security, error handling, and clarity. This is a READ-ONLY review — do not modify files. End with a one-line verdict. ${ACT}`
    },
  },
  {
    name: 'commit',
    summary: 'Stage changes and write a clean git commit',
    argHint: '[message hint]',
    build: (a) => {
      const hint = a.trim() ? `\nThe user suggests this focus for the message: "${a.trim()}".` : ''
      return `Create a git commit for the current changes. Steps, each as a real tool call: 1) "git status" and "git diff" to see what changed. 2) Group the changes and stage the right files ("git add"). 3) Write a clear Conventional-Commits message (type(scope): summary, then a short body explaining WHY). 4) Commit. 5) Show the resulting "git log -1 --stat".${hint} Do NOT push. If this is not a git repository, say so and stop. ${ACT}`
    },
  },
  {
    name: 'test',
    summary: 'Find, run and report the project tests',
    argHint: '[file | pattern]',
    build: (a) => {
      const scope = a.trim() ? `Focus on tests matching "${a.trim()}".` : 'Run the most relevant test suite.'
      return `Run the project's tests and report the result. 1) Detect the test runner (look for package.json scripts, pytest, cargo test, go test, etc. via file_read / file_list). 2) ${scope} Run it with shell_execute. 3) Summarize pass/fail counts and quote the first few real failures with their file:line. 4) If a failure has an obvious, low-risk fix, apply it and re-run to confirm; otherwise just report it. ${ACT}`
    },
  },
  {
    name: 'fix',
    summary: 'Diagnose and fix a bug or failing test end-to-end',
    argHint: '<error text | file>',
    build: (a) => {
      const what = a.trim() || 'the failing test or error in the current project (run the tests / build to surface it first)'
      return `Diagnose and fix: ${what}. 1) Reproduce — run the test/build/command that fails and read the real error. 2) Locate the root cause with file_search / file_read (fix the cause, not the symptom). 3) Apply the minimal correct fix with file_write. 4) Re-run to prove it's fixed. 5) Briefly state the root cause and the fix. ${ACT}`
    },
  },
  {
    name: 'explain',
    summary: 'Explain how a file, function or the codebase works',
    argHint: '<file | function | topic>',
    readOnly: true,
    build: (a) => {
      const what = a.trim() || 'this project: scan the structure with file_list and read the entry points'
      return `Explain ${what}. Read the actual code first (file_read / file_list / file_search) — do not guess. Give: a one-paragraph overview, then the key pieces (what each does and how they connect), the important data flow or control flow, and any non-obvious gotchas. Use short concrete references like file:line. This is read-only — do not modify anything. ${ACT}`
    },
  },
  {
    name: 'refactor',
    summary: 'Refactor code for clarity without changing behavior',
    argHint: '<file | function>',
    build: (a) => {
      const what = a.trim() || 'the file the user is focused on (ask which if it is unclear)'
      return `Refactor ${what} to improve readability and structure WITHOUT changing its observable behavior. 1) Read it fully first. 2) Make the change with file_write — improve names, remove duplication, simplify control flow, tighten types; keep the public API identical. 3) If tests exist, run them to prove behavior is unchanged. 4) Summarize what you changed and why. Do not mix in unrelated changes. ${ACT}`
    },
  },
  {
    name: 'docs',
    summary: 'Generate or update documentation',
    argHint: '[file | "readme"]',
    build: (a) => {
      const target = a.trim()
        ? `documentation for "${a.trim()}"`
        : 'the project README (create or update README.md)'
      return `Write or update ${target}. Read the real code first so the docs are accurate. For a README: a clear title + one-line description, install/setup, usage with a runnable example, and key features — match the project's actual stack. For a file/module: concise doc-comments on the public functions. Write the file(s) with file_write. Keep it accurate and skimmable, no filler. ${ACT}`
    },
  },
  {
    name: 'security',
    summary: 'Security audit — find vulnerabilities by severity',
    argHint: '[file | "."]',
    readOnly: true,
    build: (a) => {
      const scope = a.trim() || 'the project (scan the most security-relevant files: auth, input handling, file/network/shell access, secrets, dependencies)'
      return `Do a security audit of ${scope}. Read the real code with file_read / file_search. Look for: injection (SQL/command/path), unsafe input handling, auth/authorization gaps, SSRF, secrets committed in code, unsafe deserialization, and risky dependencies. Report each finding with severity (Critical/High/Medium/Low), the file:line, why it's exploitable, and the fix. READ-ONLY — do not modify files. If you find nothing serious, say so honestly. ${ACT}`
    },
  },
  {
    name: 'optimize',
    summary: 'Find and apply performance improvements',
    argHint: '<file | function>',
    build: (a) => {
      const what = a.trim() || 'the hottest path in the current project (identify it first by reading the code)'
      return `Optimize the performance of ${what}. 1) Read it and identify the real bottleneck (algorithmic complexity, redundant work, N+1 calls, unnecessary allocations, blocking I/O) — measure with a quick benchmark via shell_execute if feasible. 2) Apply the highest-impact change with file_write, preserving behavior. 3) Verify correctness (run tests if present) and, if you benchmarked, report before/after. Don't micro-optimize cold paths. ${ACT}`
    },
  },
  {
    name: 'init',
    summary: 'Scan the project and write an AGENTS.md overview',
    argHint: '',
    build: () =>
      `Analyze this project and write an AGENTS.md at its root that helps an AI agent work here effectively. 1) Explore the structure with file_list and read the key config + entry-point files. 2) Write AGENTS.md with file_write containing: project purpose (one paragraph), the tech stack, how to build / run / test (the real commands), the directory layout (what lives where), and any important conventions or gotchas you observed. Keep it factual and based on what you actually read — no guessing. If an AGENTS.md already exists, update it. ${ACT}`,
  },
]

const BY_NAME = new Map(AGENT_COMMANDS.map((c) => [c.name, c]))

/**
 * Parse a chat input into a slash command + expanded agent prompt, or null if
 * it isn't a known command. Matches only `/<name>` at the very start (optionally
 * followed by args). `/notacommand` and a bare `/` return null so they fall
 * through to normal chat. The leading slash and name are case-insensitive.
 */
export function parseAgentCommand(
  input: string,
): { command: AgentCommand; args: string; expanded: string } | null {
  const m = /^\/([a-z][a-z0-9_-]*)(?:\s+([\s\S]*))?$/i.exec(input.trim())
  if (!m) return null
  const command = BY_NAME.get(m[1].toLowerCase())
  if (!command) return null
  const args = (m[2] ?? '').trim()
  return { command, args, expanded: command.build(args) }
}

/**
 * Autocomplete: given what the user has typed after a leading `/`, return the
 * matching commands (prefix match on the name, case-insensitive). An empty
 * prefix returns all of them. Returns [] when the text isn't a lone slash token
 * (e.g. there's already a space → the user is typing args, not picking).
 */
export function matchAgentCommands(input: string): AgentCommand[] {
  const m = /^\/([a-z0-9_-]*)$/i.exec(input)
  if (!m) return []
  const prefix = m[1].toLowerCase()
  return AGENT_COMMANDS.filter((c) => c.name.startsWith(prefix))
}
