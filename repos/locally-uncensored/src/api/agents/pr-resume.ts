/**
 * pr_resume — Claude-Code-style "/resume <pr-url>" support.
 *
 * Given a GitHub PR URL, fetches title, body, head ref, latest comments,
 * and a unified diff via the local `gh` CLI in a single call. The
 * builtin tool wraps three `gh` invocations + the URL parser so the
 * model gets a compact, ready-to-paraphrase snapshot of where the PR
 * left off.
 *
 * Pure helpers (parser + renderer) live here so they can be unit-tested
 * without touching the bridge.
 */

export interface PrLocator {
  owner: string
  repo: string
  number: number
}

export interface PrResumePayload {
  url: string
  title: string
  body: string
  state: string
  headRefName: string
  baseRefName: string
  author?: string
  comments: Array<{ author: string; body: string; createdAt: string }>
  diff: string
}

const PR_URL_RE = /^https?:\/\/github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)(?:[?#/].*)?$/

export function parsePrUrl(url: string): PrLocator | null {
  const m = (url ?? '').trim().match(PR_URL_RE)
  if (!m) return null
  const num = parseInt(m[3], 10)
  if (!Number.isFinite(num) || num <= 0) return null
  return { owner: m[1], repo: m[2], number: num }
}

/**
 * Compact a verbose `gh pr view --json` response into a renderer-friendly
 * shape. The bridge returns a raw JSON blob; this normalises field names
 * + truncates long comment bodies so the system-prompt section fits.
 */
export function normalisePrJson(raw: any, url: string): Omit<PrResumePayload, 'diff'> {
  const comments: PrResumePayload['comments'] = Array.isArray(raw?.comments)
    ? raw.comments
        .slice(-12) // last 12 — older comments are usually stale
        .map((c: any) => ({
          author: String(c?.author?.login ?? c?.author ?? 'unknown'),
          body: clip(String(c?.body ?? ''), 600),
          createdAt: String(c?.createdAt ?? ''),
        }))
    : []
  return {
    url,
    title: String(raw?.title ?? ''),
    body: clip(String(raw?.body ?? ''), 4000),
    state: String(raw?.state ?? 'UNKNOWN'),
    headRefName: String(raw?.headRefName ?? ''),
    baseRefName: String(raw?.baseRefName ?? ''),
    author: raw?.author?.login ? String(raw.author.login) : undefined,
    comments,
  }
}

function clip(s: string, n: number): string {
  if (s.length <= n) return s
  return `${s.slice(0, n).trimEnd()}\n…(truncated, ${s.length - n} chars dropped)`
}

/**
 * Renders the structured PR payload as a markdown summary the model
 * can use to orient itself. Designed to land at the top of the next
 * user message so the model has full context for "continue this PR".
 */
export function renderPrResume(p: PrResumePayload): string {
  const head = [
    `# PR ${p.url}`,
    `**State:** ${p.state}  **Branch:** ${p.headRefName} → ${p.baseRefName}` +
      (p.author ? `  **Author:** @${p.author}` : ''),
    '',
    `## Title`,
    p.title || '(no title)',
    '',
    `## Description`,
    p.body || '(empty)',
    '',
  ].join('\n')
  const comments = p.comments.length
    ? [
        '## Latest comments',
        ...p.comments.map(
          (c) =>
            `- **@${c.author}** (${c.createdAt}):\n  ${c.body.replace(/\n/g, '\n  ')}`,
        ),
        '',
      ].join('\n')
    : ''
  const diff = p.diff
    ? `## Diff\n\n\`\`\`diff\n${clip(p.diff, 8000)}\n\`\`\`\n`
    : ''
  return `${head}${comments}${diff}`
}
