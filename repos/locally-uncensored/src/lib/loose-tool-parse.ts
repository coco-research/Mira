/**
 * Loose tool-call extraction — the safety net for weak local models that
 * "describe" a tool call in their TEXT answer instead of emitting it through
 * the native `tool_calls` channel.
 *
 * Native tool_calls (Ollama `tools`) and Hermes `<tool_call>` XML are handled
 * directly in useAgentChat. This module is the fallback for everything in
 * between — observed LIVE on the only locally-installed agent models:
 *   - gemma4:e4b  → often answers in prose, occasionally writes the call
 *   - qwen2.5-coder:14b → wrote `image_generate(prompt="a small red cube …")`
 *     as plain answer text and never used the structured channel.
 * Without this, the chat-agent image/video flow simply never fires for these
 * models. With it, ANY recognizable call (function-syntax, JSON object, Hermes
 * tag) the model wrote into its answer is lifted into a real tool call.
 *
 * SAFETY: only calls whose name is in `known` are returned, so ordinary prose
 * that happens to contain parentheses or a stray `{}` can't be misread as a
 * tool invocation. The matched snippet is also reported so the caller can strip
 * it from the visible answer (we don't want the raw `foo(...)` echoed as prose).
 */

import { repairJson } from './tool-call-repair'
import { parseHermesToolCalls } from '../api/hermes-tool-calling'

export interface LooseToolCall {
  name: string
  arguments: Record<string, unknown>
}

export interface LooseParseResult {
  calls: LooseToolCall[]
  /** The exact substrings that were recognized as calls (for stripping from prose). */
  matched: string[]
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** Coerce a scalar token ("..."/'...'/number/true/false) into a JS value. */
function coerceScalar(raw: string): unknown {
  const v = raw.trim()
  if (v === 'true') return true
  if (v === 'false') return false
  if (v === 'null') return null
  if (/^-?\d+(?:\.\d+)?$/.test(v)) return Number(v)
  // quoted string → unquote + unescape
  if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
    return v.slice(1, -1).replace(/\\(["'\\])/g, '$1')
  }
  return v
}

/**
 * Parse the inside of a `name( ... )` call into an arguments object.
 * Handles `key="val"`, `key='val'`, `key: "val"`, `key=123`, `key=true`, and a
 * single positional string (mapped to `prompt`, the natural arg for the
 * creative tools this fallback exists for).
 */
function parseCallArgs(inner: string): Record<string, unknown> {
  const args: Record<string, unknown> = {}
  const kw = /([A-Za-z_]\w*)\s*[:=]\s*("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|true|false|null|-?\d+(?:\.\d+)?)/g
  let m: RegExpExecArray | null
  let found = false
  while ((m = kw.exec(inner)) !== null) {
    found = true
    args[m[1]] = coerceScalar(m[2])
  }
  if (!found) {
    // Positional single string → prompt (e.g. image_generate("a red cube")).
    const s = inner.trim().replace(/^["']|["']$/g, '').trim()
    if (s) args.prompt = s
  }
  return args
}

/** Find bare/fenced JSON objects that name a known tool: {"name":"X","arguments":{…}}. */
function parseJsonObjectCalls(text: string, known: Set<string>): { call: LooseToolCall; snippet: string }[] {
  const calls: { call: LooseToolCall; snippet: string }[] = []
  // Scan every top-level-ish {...} candidate. Cheap brace-scan; repairJson
  // tolerates trailing commas / single quotes / unquoted keys.
  const candidates: string[] = []
  let depth = 0
  let start = -1
  for (let i = 0; i < text.length; i++) {
    const c = text[i]
    if (c === '{') {
      if (depth === 0) start = i
      depth++
    } else if (c === '}') {
      depth--
      if (depth === 0 && start >= 0) {
        candidates.push(text.slice(start, i + 1))
        start = -1
      }
      if (depth < 0) depth = 0
    }
  }
  for (const cand of candidates) {
    if (!/["']?(?:name|tool|tool_name|tool_call|function)["']?\s*[:=]/.test(cand)) continue
    const parsed = repairJson(cand) as Record<string, any> | null
    if (!parsed) continue
    // Name + args may arrive in three shapes, all seen from small local models:
    //   flat     {"name":"file_list","arguments":{…}}
    //   nested   {"function":{"name":"file_list","arguments":{…}}}  (OpenAI/Phi)
    //   wrapped  {"tool_call":{"name":…}} or {"tool_call":"file_list","arguments":{…}}
    // Unwrap an object-valued name carrier so the nested forms resolve too.
    let nameField: any = parsed.name || parsed.tool || parsed.tool_name || parsed.tool_call || parsed.function
    let argsField: any = parsed.arguments ?? parsed.parameters ?? parsed.args ?? parsed.params
    if (nameField && typeof nameField === 'object') {
      argsField = argsField ?? nameField.arguments ?? nameField.parameters ?? nameField.args
      nameField = nameField.name || nameField.tool || nameField.tool_name
    }
    if (typeof nameField === 'string' && known.has(nameField)) {
      // Arguments can arrive as a JSON STRING (OpenAI serializes them) — repair it.
      let a: any = argsField ?? {}
      if (typeof a === 'string') { const p2 = repairJson(a); a = p2 && typeof p2 === 'object' ? p2 : {} }
      // Report the source snippet so the caller can strip the raw JSON object
      // from the visible prose (otherwise it leaks as a "notes"/JSON block).
      calls.push({ call: { name: nameField, arguments: (a && typeof a === 'object') ? a : {} }, snippet: cand })
    }
  }
  return calls
}

/**
 * Extract tool calls a model wrote into its text answer. Returns the calls plus
 * the matched source snippets (so the caller can strip them from the prose).
 * Only `known` tool names are recognized.
 */
export function parseLooseToolCalls(text: string, known: string[]): LooseParseResult {
  if (!text || !text.trim()) return { calls: [], matched: [] }
  const knownSet = new Set(known)
  const calls: LooseToolCall[] = []
  const matched: string[] = []
  const seen = new Set<string>()

  const push = (c: LooseToolCall, snippet: string) => {
    // Dedupe by name + JSON of args so the same call found by two patterns
    // isn't executed twice.
    const key = c.name + '|' + JSON.stringify(c.arguments)
    if (seen.has(key)) return
    seen.add(key)
    calls.push(c)
    if (snippet) matched.push(snippet)
  }

  // 1) Hermes <tool_call>{…}</tool_call> tags (some models emit these in content).
  if (/<tool_call>/i.test(text)) {
    for (const hc of parseHermesToolCalls(text)) {
      if (knownSet.has(hc.name)) push({ name: hc.name, arguments: hc.arguments || {} }, '')
    }
    const tagRe = /<tool_call>[\s\S]*?<\/tool_call>/gi
    let tm: RegExpExecArray | null
    while ((tm = tagRe.exec(text)) !== null) matched.push(tm[0])
  }

  // 2) JSON objects naming a known tool (snippet reported so prose can be cleaned).
  for (const { call, snippet } of parseJsonObjectCalls(text, knownSet)) push(call, snippet)

  // 3) Function-call syntax  name( ... )  — only for known tool names.
  for (const name of knownSet) {
    const re = new RegExp(`\\b${escapeRe(name)}\\s*\\(([\\s\\S]*?)\\)`, 'g')
    let m: RegExpExecArray | null
    while ((m = re.exec(text)) !== null) {
      const args = parseCallArgs(m[1])
      // Require at least one arg — `image_generate()` with nothing is not a
      // usable call (and is more likely the model naming the tool in prose).
      if (Object.keys(args).length > 0) push({ name, arguments: args }, m[0])
    }
  }

  // 4) Brace / bracket form  name {json}  or  [name {json}]  — only known names.
  //    Phi-4-mini (and other non-Hermes small models) emit the args as a JSON
  //    object placed AFTER the bare name, sometimes wrapped in [ ], with NO
  //    `name` key inside the brace (so patterns 2/3 miss it). Observed live:
  //    `[file_read {"path": "/package.json"}]`. Require a non-empty object so a
  //    stray `tool {}` or prose brace isn't misread as a call.
  for (const name of knownSet) {
    const re = new RegExp(`\\[?\\s*\\b${escapeRe(name)}\\b\\s*(\\{(?:[^{}]|\\{[^{}]*\\})*\\})\\s*\\]?`, 'g')
    let m: RegExpExecArray | null
    while ((m = re.exec(text)) !== null) {
      const parsed = repairJson(m[1]) as Record<string, any> | null
      if (!parsed || typeof parsed !== 'object') continue
      // The brace may BE the args, or wrap them under arguments/parameters.
      const inner = parsed.arguments ?? parsed.parameters ?? parsed.args ?? parsed.params
      const args = inner && typeof inner === 'object' ? inner : parsed
      if (args && typeof args === 'object' && Object.keys(args).length > 0) {
        push({ name, arguments: args as Record<string, unknown> }, m[0])
      }
    }
  }

  return { calls, matched }
}

// Common near-miss tool names small models emit instead of the registered ones
// (gemma4 live: called `video_generation` → "Unknown tool" → gave up). Maps to
// the canonical builtin names. Only applied when the alias target is actually a
// known/registered tool, so this never invents capabilities.
const TOOL_NAME_ALIASES: Record<string, string> = {
  image_generation: 'image_generate', generate_image: 'image_generate', imagegen: 'image_generate',
  create_image: 'image_generate', make_image: 'image_generate', draw_image: 'image_generate', text_to_image: 'image_generate',
  video_generation: 'video_generate', generate_video: 'video_generate', videogen: 'video_generate',
  create_video: 'video_generate', make_video: 'video_generate', animate: 'video_generate', animate_image: 'video_generate',
  text_to_video: 'video_generate', image_to_video: 'video_generate',
  web: 'web_search', search: 'web_search', fetch: 'web_fetch', read_file: 'file_read', write_file: 'file_write',
  list_files: 'file_list', search_files: 'file_search', run_shell: 'shell_execute', run_code: 'code_execute',
}

/**
 * Map a model-emitted tool name to a registered one. Tries exact, lowercase,
 * an explicit alias table, then a punctuation-insensitive equality. Returns the
 * original name unchanged when no confident match exists (so genuinely unknown
 * tools still error rather than being silently rerouted).
 */
export function canonicalToolName(name: string, known: string[]): string {
  if (!name) return name
  if (known.includes(name)) return name
  const lc = name.toLowerCase()
  if (known.includes(lc)) return lc
  const alias = TOOL_NAME_ALIASES[lc]
  if (alias && known.includes(alias)) return alias
  // Punctuation/casing-insensitive equality (videoGenerate, video-generate…).
  const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '')
  const target = norm(name)
  for (const k of known) if (norm(k) === target) return k
  return name
}

/** Remove the matched call snippets from a prose answer (best-effort). */
export function stripMatchedCalls(text: string, matched: string[]): string {
  let out = text
  for (const snip of matched) {
    if (snip) out = out.split(snip).join('')
  }
  // Tidy leftover empty code fences / blank lines.
  return out.replace(/```(?:json|python|tool_code)?\s*```/gi, '').replace(/\n{3,}/g, '\n\n').trim()
}

/**
 * Strip ANY recognizable tool-call text (JSON object, function-syntax, Hermes
 * tag, or a fenced ```json block that is actually a call) out of a model's
 * VISIBLE prose. Unlike the loose-parse → strip path (which only runs when the
 * native channel produced nothing), this is meant to run on EVERY turn's
 * content so a model that emits a proper native call AND echoes the same call
 * as text doesn't leak raw JSON into the chat as a "notes"/JSON block.
 *
 * Only `known` tool names are recognized, so ordinary prose with stray braces
 * is left intact. Tool args/results remain in the agent's internal history —
 * this only cleans what the USER sees in the bubble.
 */
export function stripToolCallText(text: string, known: string[]): string {
  if (!text || !text.trim()) return ''
  const { matched } = parseLooseToolCalls(text, known)
  let out = stripMatchedCalls(text, matched)
  // Drop fenced code blocks whose body is a tool call (```json {"name":…}```).
  out = out.replace(/```(?:json|tool_code|tool|python)?\s*([\s\S]*?)```/gi, (m, inner) => {
    const looksLikeCall =
      /["']?(?:name|tool|function)["']?\s*[:=]/.test(inner) &&
      /["']?(?:arguments|parameters|params|prompt)["']?\s*[:=]/.test(inner)
    return looksLikeCall ? '' : m
  })
  return out
    // Strip special-token tool-call wrappers some models leave in the prose
    // (Phi-4: <|tool_call|>/<|tool|>; Mistral: [TOOL_CALLS]) so they don't show
    // in the bubble. Detection/parsing above already handled the JSON inside.
    .replace(/<\|\/?tool(?:_call)?(?:_start|_end)?\|>/gi, '')
    .replace(/\[\/?TOOL_CALLS?\]/gi, '')
    .replace(/```(?:json|tool_code)?\s*```/gi, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}
