/**
 * Tool Call Repair — fixes broken JSON from local LLMs.
 *
 * Common issues:
 * - Trailing commas in JSON objects/arrays
 * - Single quotes instead of double quotes
 * - Missing closing braces/brackets
 * - Unquoted property names
 * - Extra text before/after JSON
 * - Escaped quotes inside strings
 */

/**
 * Attempt to repair broken JSON from a tool call.
 * Returns parsed object or null if unfixable.
 */
export function repairJson(raw: string): any | null {
  // 1. Try direct parse first
  try { return JSON.parse(raw) } catch {}

  let fixed = raw.trim()

  // 2. Extract JSON from surrounding text (model might wrap it)
  const jsonMatch = fixed.match(/\{[\s\S]*\}/)
  if (jsonMatch) fixed = jsonMatch[0]

  // 3. Fix single quotes → double quotes (but not inside strings)
  fixed = fixed.replace(/'/g, '"')

  // 4. Fix trailing commas
  fixed = fixed.replace(/,\s*([}\]])/g, '$1')

  // 5. Fix unquoted keys: { key: "value" } → { "key": "value" }
  fixed = fixed.replace(/(\{|,)\s*([a-zA-Z_]\w*)\s*:/g, '$1"$2":')

  // 6. Fix missing closing braces
  const openBraces = (fixed.match(/\{/g) || []).length
  const closeBraces = (fixed.match(/\}/g) || []).length
  for (let i = 0; i < openBraces - closeBraces; i++) fixed += '}'

  const openBrackets = (fixed.match(/\[/g) || []).length
  const closeBrackets = (fixed.match(/\]/g) || []).length
  for (let i = 0; i < openBrackets - closeBrackets; i++) fixed += ']'

  // 7. Try parse again
  try { return JSON.parse(fixed) } catch {}

  // 8. Last resort: try to extract key-value pairs with regex
  try {
    const nameMatch = raw.match(/["']?name["']?\s*[:=]\s*["']([^"']+)["']/i)
    const argsMatch = raw.match(/["']?arguments["']?\s*[:=]\s*(\{[^}]*\})/i)
    if (nameMatch) {
      let args = {}
      if (argsMatch) {
        try { args = JSON.parse(argsMatch[1].replace(/'/g, '"')) } catch {}
      }
      return { name: nameMatch[1], arguments: args }
    }
  } catch {}

  return null
}

/**
 * Repair tool call arguments that might be a string instead of object.
 */
export function repairToolCallArgs(args: any): Record<string, any> {
  if (typeof args === 'object' && args !== null) return args
  if (typeof args === 'string') {
    const parsed = repairJson(args)
    if (parsed && typeof parsed === 'object') return parsed
  }
  return {}
}

/**
 * Extract tool calls from model content when native tool calling fails.
 * Looks for JSON patterns that look like tool calls.
 */
export function extractToolCallsFromContent(content: string): { name: string; arguments: Record<string, any> }[] {
  return extractToolCallsWithRanges(content).calls
}

/**
 * Does this text read as "the model wants to call a tool"? Used for the
 * thought-only empty-reply case (live find 2026-06-11): gemma4, primed by
 * remembered tool results, spends the whole turn reasoning "I need to use the
 * web_search tool", emits zero content and stops — the REASONING is the only
 * evidence of intent. Matches a structured call shape anywhere in the text or
 * one of LU's builtin tool names used as an identifier.
 */
export function looksLikeToolIntent(text: string): boolean {
  if (!text) return false
  if (extractToolCallsFromContent(text).length > 0) return true
  // name({...}) / name(query=…) call shapes, or an LU builtin named verbatim.
  if (/\b[a-z][a-z0-9_]{2,}\s*\(\s*[{"']/.test(text)) return true
  return /\b(web_search|web_fetch|image_generate|video_generate|file_read|file_write|file_list|file_search|shell_execute|system_info)\b/.test(text)
}

/**
 * Like extractToolCallsFromContent but also returns the `[startIdx, endIdx]`
 * range each tool-call occupies in `content`. Callers can use the ranges to
 * strip the raw JSON from the displayed content after extraction so the user
 * sees a clean chat bubble instead of the rattling JSON stream that small
 * models (qwen2.5-coder:3b) emit.
 */
export function extractToolCallsWithRanges(content: string): {
  calls: { name: string; arguments: Record<string, any> }[]
  ranges: Array<[number, number]>
} {
  const calls: { name: string; arguments: Record<string, any> }[] = []
  const ranges: Array<[number, number]> = []

  // Pattern 1: {"name": "tool_name", "arguments": {...}}
  //
  // The naive regex `\{[^}]*\}` fails for ANY JSON with nested braces OR for
  // string values containing `{` (e.g. Python f-strings `f'Hello, {name}!'`
  // emitted by qwen2.5-coder). Replace with a locate-header-then-balance
  // scanner: find the `"arguments":` key, then walk the character stream
  // respecting string escapes to find the matching `}`.
  const headerRe = /"(?:name|tool|function)"\s*:\s*"([^"]+)"\s*,\s*"(?:arguments|args|parameters|input)"\s*:\s*\{/gi
  let m: RegExpExecArray | null
  while ((m = headerRe.exec(content)) !== null) {
    const toolName = m[1]
    const argsStart = headerRe.lastIndex - 1 // the `{` of arguments object
    const argsEnd = findBalancedBraceEnd(content, argsStart)
    if (argsEnd < 0) continue
    const argsJson = content.slice(argsStart, argsEnd + 1)
    const args = repairJson(argsJson)
    if (args) {
      calls.push({ name: toolName, arguments: args })
      // The full tool-call JSON range: walk backwards from m.index to include
      // the opening `{` of the outer wrapper, and walk forward from argsEnd
      // to include the closing `}` of the wrapper (one level out).
      const outerStart = findPrecedingOpenBrace(content, m.index)
      const outerEnd = findBalancedBraceEnd(content, outerStart >= 0 ? outerStart : m.index)
      ranges.push([
        outerStart >= 0 ? outerStart : m.index,
        outerEnd > argsEnd ? outerEnd : argsEnd,
      ])
    }
    headerRe.lastIndex = argsEnd + 1
  }

  // Pattern 2: tool_name(arg1, arg2) — function call syntax
  if (calls.length === 0) {
    const pattern2 = /\b(web_search|web_fetch|file_read|file_write|file_list|file_search|shell_execute|code_execute|system_info|process_list|screenshot)\s*\(\s*([^)]*)\)/gi
    let match: RegExpExecArray | null
    while ((match = pattern2.exec(content)) !== null) {
      ranges.push([match.index, match.index + match[0].length - 1])
      const argStr = match[2].trim()
      let args: Record<string, any> = {}
      if (argStr) {
        // Try to parse as JSON
        const parsed = repairJson(`{${argStr}}`)
        if (parsed) args = parsed
        else {
          // Simple single-argument: treat as the first required param
          args = { query: argStr.replace(/^["']|["']$/g, '') }
        }
      }
      calls.push({ name: match[1], arguments: args })
    }
  }

  return { calls, ranges }
}

/**
 * Scan backwards from `fromIdx` and return the index of the nearest
 * preceding `{` that is NOT inside a string. Returns -1 if none found.
 * Used to locate the outer wrapper `{` of a tool-call JSON so the full
 * object (not just its `arguments` sub-object) can be stripped from the
 * displayed content after extraction.
 */
function findPrecedingOpenBrace(src: string, fromIdx: number): number {
  // Simple backwards scan — we assume the small window we inspect is not
  // inside a string that starts before fromIdx; in practice the outer
  // wrapper `{` is always at most a few dozen chars back with whitespace
  // and commentary in between.
  for (let i = fromIdx - 1; i >= Math.max(0, fromIdx - 200); i--) {
    if (src[i] === '{') return i
  }
  return -1
}

/**
 * Strip the text ranges `[start,end]` out of `content` and return the
 * cleaned-up result. Ranges are sliced in reverse order so earlier indices
 * stay valid. Also removes orphan ```json / ``` code fences that wrapped
 * the now-removed JSON.
 */
export function stripRanges(content: string, ranges: Array<[number, number]>): string {
  if (ranges.length === 0) return content
  const sorted = [...ranges].sort((a, b) => b[0] - a[0])
  let out = content
  for (const [start, end] of sorted) {
    if (start < 0 || end < start) continue
    out = out.slice(0, start) + out.slice(end + 1)
  }
  // Remove orphan fence lines left behind by the JSON strip.
  out = out.replace(/```(?:json)?\s*\n?\s*```/g, '')
  // Collapse 3+ consecutive blank lines down to one blank line so the chat
  // bubble doesn't have a sea of whitespace where the JSON used to be.
  out = out.replace(/\n{3,}/g, '\n\n')
  return out.trim()
}

/**
 * Walk JSON starting at `start` (which must be `{`) and return the index of
 * the matching `}` — respecting string escapes so `{` and `}` inside string
 * literals don't count. Returns -1 if unbalanced/malformed.
 */
function findBalancedBraceEnd(src: string, start: number): number {
  if (src[start] !== '{') return -1
  let depth = 0
  let i = start
  let inString = false
  let escape = false
  while (i < src.length) {
    const c = src[i]
    if (inString) {
      if (escape) { escape = false }
      else if (c === '\\') { escape = true }
      else if (c === '"') { inString = false }
    } else {
      if (c === '"') inString = true
      else if (c === '{') depth++
      else if (c === '}') {
        depth--
        if (depth === 0) return i
      }
    }
    i++
  }
  return -1
}
