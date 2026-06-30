// Feature CC v2.5.0 — Chatbot export importer (MikeS++ Discord 2026-05-27).
// Parses ChatGPT / Claude / Gemini conversation exports and produces a
// normalised list of `{title, markdown}` items the rest of the importer can
// feed into the RAG pipeline as if they were ordinary text uploads.
//
// We accept either a raw JSON file (the user already unzipped the export)
// or a .zip (we walk it for conversations.json). The parsers are loose by
// design: each platform's export schema has churned multiple times, and
// failing to import a conversation is much better than crashing the whole
// import run. Unrecognised entries are skipped and counted in the result
// so the UI can surface a "skipped N items" hint.

import JSZip from 'jszip'

export type ChatbotPlatform = 'chatgpt' | 'claude' | 'gemini' | 'unknown'

export interface NormalisedConversation {
  /** Stable id for the import list (filename-safe). */
  id: string
  /** Human-readable title (falls back to "Untitled <date>"). */
  title: string
  /** Final markdown a RAG processor will consume. */
  markdown: string
  /** Best-guess platform — surfaced as the document's source field. */
  platform: ChatbotPlatform
  /** ISO timestamp of the conversation (creation or last update). */
  timestamp: string | null
  /** Message count, for the UI. */
  messageCount: number
}

export interface ParseResult {
  conversations: NormalisedConversation[]
  /** Number of items in the raw export we couldn't map to a conversation. */
  skipped: number
  /** Detected platform across the export (heuristic). */
  detectedPlatform: ChatbotPlatform
}

/** Read a File object as text. */
async function readFileAsText(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result))
    reader.onerror = () => reject(reader.error || new Error('FileReader failed'))
    reader.readAsText(file)
  })
}

/** Detect platform from the parsed JSON shape. */
export function detectPlatform(parsed: unknown): ChatbotPlatform {
  if (!parsed) return 'unknown'
  if (Array.isArray(parsed) && parsed.length > 0) {
    const sample = parsed[0] as Record<string, unknown>
    // ChatGPT exports use `mapping` (id → message node).
    if (sample && typeof sample === 'object' && 'mapping' in sample) return 'chatgpt'
    // Claude uses `chat_messages` (array of { sender, text }).
    if (sample && typeof sample === 'object' && 'chat_messages' in sample) return 'claude'
    // Gemini Takeout activity exports use `title` + `messages` and `header` = "Gemini Apps"
    if (sample && typeof sample === 'object' && 'header' in sample && String((sample as any).header || '').toLowerCase().includes('gemini')) return 'gemini'
  }
  // Some Gemini bundles use a wrapper { activities: [...] }.
  if (typeof parsed === 'object' && parsed !== null && 'activities' in parsed) return 'gemini'
  return 'unknown'
}

/** Sanitise a string for use as a filename / id. */
function slugify(s: string, fallback: string): string {
  const cleaned = (s || '').trim().replace(/[\\/:*?"<>|]/g, '_').slice(0, 80)
  return cleaned || fallback
}

// ── ChatGPT ────────────────────────────────────────────────────────────
// Schema (verified against OpenAI Data Export Aug 2024 + Apr 2026):
//   [
//     {
//       "title": "...",
//       "create_time": 1700000000.0,
//       "update_time": 1700001000.0,
//       "mapping": {
//         "<uuid>": {
//           "id": "<uuid>",
//           "message": null | {
//             "id": "...",
//             "author": { "role": "system" | "user" | "assistant" | "tool", ... },
//             "create_time": 1700000000.0,
//             "content": { "content_type": "text", "parts": ["..."] }
//           },
//           "parent": "<uuid>" | null,
//           "children": ["<uuid>", ...]
//         }
//       }
//     }
//   ]
// Pull readable text out of a ChatGPT message `content` object. Real exports
// use several content_type shapes:
//   { content_type: 'text', parts: ['...'] }
//   { content_type: 'multimodal_text', parts: ['...', { content_type:'image_asset_pointer', ... }] }
//   { content_type: 'code' | 'execution_output', text: '...' }
//   { content_type: 'tether_*' , result: '...' }
// Strings in `parts` are kept; non-text parts (image/audio pointers) are
// skipped gracefully; falls back to `content.text` / `content.result`.
function extractChatGptText(content: any): string {
  if (!content || typeof content !== 'object') return ''
  const chunks: string[] = []
  if (Array.isArray(content.parts)) {
    for (const p of content.parts) {
      if (typeof p === 'string') { if (p.trim()) chunks.push(p) }
      else if (p && typeof p === 'object' && typeof p.text === 'string') { if (p.text.trim()) chunks.push(p.text) }
      // image_asset_pointer / audio_asset_pointer / etc. carry no readable text → skip
    }
  }
  if (chunks.length === 0 && typeof content.text === 'string' && content.text.trim()) chunks.push(content.text)
  if (chunks.length === 0 && typeof content.result === 'string' && content.result.trim()) chunks.push(content.result)
  return chunks.join('\n').trim()
}

// Turn an ordered list of mapping nodes (root → leaf) into markdown lines.
function linearizeChatGptNodes(nodes: any[]): { lines: string[]; count: number } {
  const lines: string[] = []
  let count = 0
  for (const node of nodes) {
    const msg = node?.message
    if (msg && msg.author && msg.content) {
      const role = String(msg.author.role || 'unknown')
      const text = extractChatGptText(msg.content)
      if (text && role !== 'tool' && role !== 'system') {
        const heading = role === 'user' ? '**You**' : (role === 'assistant' ? '**Assistant**' : `**${role}**`)
        lines.push(heading, '', text, '')
        count++
      }
    }
  }
  return { lines, count }
}

function parseChatGpt(raw: unknown): NormalisedConversation[] {
  if (!Array.isArray(raw)) return []
  const out: NormalisedConversation[] = []
  for (const conv of raw) {
    if (!conv || typeof conv !== 'object') continue
    const c = conv as Record<string, unknown>
    const title = String(c.title || '').trim() || 'Untitled ChatGPT conversation'
    const createTime = typeof c.create_time === 'number' ? c.create_time : null
    const updateTime = typeof c.update_time === 'number' ? c.update_time : null
    const timestamp = updateTime ?? createTime
    const isoTimestamp = timestamp ? new Date(timestamp * 1000).toISOString() : null

    const mapping = c.mapping as Record<string, any> | undefined
    if (!mapping || typeof mapping !== 'object') continue

    // Linearise the message tree into the single thread the user actually saw.
    // Real exports have a synthetic root (message == null) and, after edits or
    // regenerations, multiple sibling branches — the old "first node with
    // parent==null, then children[0] forever" walk lands on the ORIGINAL
    // (often abandoned) branch and frequently dead-ends at 0 messages, which
    // is why mikes_pp's import produced "no conversations". Two strategies,
    // best first:
    //   1. `current_node` is the leaf of the visible thread — walk PARENT
    //      links up to the root and reverse. Exactly what the user saw.
    //   2. Fallback: from each parent-less node walk forward following the
    //      LAST (newest) child; keep whichever walk yields the most messages.
    const collectUp = (leafId: string): any[] => {
      const chain: any[] = []
      const seen = new Set<string>()
      let node: any = mapping[leafId]
      while (node && node.id && !seen.has(node.id)) {
        seen.add(node.id)
        chain.push(node)
        node = (node.parent != null) ? mapping[node.parent] : null
      }
      chain.reverse()
      return chain
    }
    const collectDown = (rootId: string): any[] => {
      const chain: any[] = []
      const seen = new Set<string>()
      let node: any = mapping[rootId]
      while (node && node.id && !seen.has(node.id)) {
        seen.add(node.id)
        chain.push(node)
        const children = Array.isArray(node.children) ? node.children : []
        const nextId = children.length > 0 ? children[children.length - 1] : null
        node = nextId ? mapping[nextId] : null
      }
      return chain
    }

    let best: { lines: string[]; count: number } | null = null
    const currentNodeId = typeof c.current_node === 'string' ? c.current_node : null
    if (currentNodeId && mapping[currentNodeId]) {
      best = linearizeChatGptNodes(collectUp(currentNodeId))
    }
    if (!best || best.count === 0) {
      const rootIds = Object.values(mapping)
        .filter((n: any) => n && n.parent == null && n.id)
        .map((n: any) => n.id as string)
      const candidates = rootIds.length > 0 ? rootIds : Object.keys(mapping)
      for (const rid of candidates) {
        const r = linearizeChatGptNodes(collectDown(rid))
        if (!best || r.count > best.count) best = r
      }
    }
    if (!best || best.count === 0) continue

    const lines: string[] = [`# ${title}`, '']
    if (isoTimestamp) lines.push(`_Created: ${isoTimestamp}_`, '')
    lines.push(...best.lines)
    out.push({
      id: slugify(title, `chatgpt_${createTime || out.length}`),
      title,
      markdown: lines.join('\n').trim(),
      platform: 'chatgpt',
      timestamp: isoTimestamp,
      messageCount: best.count,
    })
  }
  return out
}

// ── Claude ─────────────────────────────────────────────────────────────
// Schema (verified against Anthropic export Apr 2026):
//   [
//     {
//       "uuid": "...",
//       "name": "...",
//       "created_at": "2026-01-01T...",
//       "updated_at": "...",
//       "chat_messages": [
//         {
//           "uuid": "...",
//           "text": "...",
//           "sender": "human" | "assistant",
//           "created_at": "..."
//         }
//       ]
//     }
//   ]
function parseClaude(raw: unknown): NormalisedConversation[] {
  if (!Array.isArray(raw)) return []
  const out: NormalisedConversation[] = []
  for (const conv of raw) {
    if (!conv || typeof conv !== 'object') continue
    const c = conv as Record<string, unknown>
    const title = String(c.name || '').trim() || 'Untitled Claude conversation'
    const isoTimestamp = typeof c.updated_at === 'string'
      ? c.updated_at
      : (typeof c.created_at === 'string' ? c.created_at : null)
    const messages = Array.isArray(c.chat_messages) ? c.chat_messages : []
    if (messages.length === 0) continue
    const lines: string[] = [`# ${title}`, '']
    if (isoTimestamp) lines.push(`_Created: ${isoTimestamp}_`, '')
    let messageCount = 0
    for (const m of messages as any[]) {
      const sender = String(m?.sender || 'unknown')
      const text = String(m?.text || '').trim()
      if (!text) continue
      const heading = sender === 'human' ? '**You**' : (sender === 'assistant' ? '**Assistant**' : `**${sender}**`)
      lines.push(heading, '', text, '')
      messageCount++
    }
    if (messageCount === 0) continue
    out.push({
      id: slugify(title, `claude_${c.uuid || out.length}`),
      title,
      markdown: lines.join('\n').trim(),
      platform: 'claude',
      timestamp: isoTimestamp,
      messageCount,
    })
  }
  return out
}

// ── Gemini ─────────────────────────────────────────────────────────────
// Gemini exports come via Google Takeout. There are several shapes; the most
// common one is an activity-stream JSON where each entry is a Search-style
// `{ title, time, header: "Gemini Apps" }` with an inline transcript. We
// parse defensively — anything we can't extract becomes a single-message
// markdown entry that still carries the prompt text.
function parseGemini(raw: unknown): NormalisedConversation[] {
  let items: any[] = []
  if (Array.isArray(raw)) items = raw
  else if (typeof raw === 'object' && raw !== null && Array.isArray((raw as any).activities)) {
    items = (raw as any).activities
  }
  const out: NormalisedConversation[] = []
  for (const item of items) {
    if (!item || typeof item !== 'object') continue
    const i = item as Record<string, unknown>
    const header = String(i.header || '').toLowerCase()
    if (!header.includes('gemini') && !header.includes('bard')) continue
    const title = String(i.title || '').trim().slice(0, 120) || 'Gemini activity'
    const timestamp = typeof i.time === 'string' ? i.time : null
    const messages = Array.isArray(i.messages) ? i.messages : []
    const lines: string[] = [`# ${title}`, '']
    if (timestamp) lines.push(`_When: ${timestamp}_`, '')
    let messageCount = 0
    if (messages.length > 0) {
      for (const m of messages as any[]) {
        const role = String(m?.role || m?.author || 'unknown')
        const text = String(m?.text || m?.content || '').trim()
        if (!text) continue
        const heading = (role === 'user' || role === 'human') ? '**You**' : '**Assistant**'
        lines.push(heading, '', text, '')
        messageCount++
      }
    } else {
      // Single-prompt activity entry. Surface the title + body as one Q.
      lines.push('**You**', '', title, '')
      messageCount = 1
    }
    if (messageCount === 0) continue
    out.push({
      id: slugify(title, `gemini_${out.length}`),
      title,
      markdown: lines.join('\n').trim(),
      platform: 'gemini',
      timestamp,
      messageCount,
    })
  }
  return out
}

/** Parse a single JSON blob (already-decoded string). */
export function parseJsonText(text: string): ParseResult {
  let parsed: unknown
  try { parsed = JSON.parse(text) } catch {
    return { conversations: [], skipped: 0, detectedPlatform: 'unknown' }
  }
  const detected = detectPlatform(parsed)
  let convs: NormalisedConversation[] = []
  switch (detected) {
    case 'chatgpt': convs = parseChatGpt(parsed); break
    case 'claude': convs = parseClaude(parsed); break
    case 'gemini': convs = parseGemini(parsed); break
    default:
      // Last-ditch: try them all, return whichever produced the most output.
      const tries: Array<[ChatbotPlatform, NormalisedConversation[]]> = [
        ['chatgpt', parseChatGpt(parsed)],
        ['claude', parseClaude(parsed)],
        ['gemini', parseGemini(parsed)],
      ]
      tries.sort((a, b) => b[1].length - a[1].length)
      convs = tries[0][1]
      if (convs.length === 0) return { conversations: [], skipped: 1, detectedPlatform: 'unknown' }
  }
  const rawLen = Array.isArray(parsed) ? (parsed as unknown[]).length : 1
  const skipped = Math.max(0, rawLen - convs.length)
  return { conversations: convs, skipped, detectedPlatform: convs[0]?.platform || detected }
}

/** Parse a user-provided File (either .json or a .zip that contains conversations.json). */
export async function parseExportFile(file: File): Promise<ParseResult> {
  const name = file.name.toLowerCase()
  if (name.endsWith('.zip')) {
    const zip = await JSZip.loadAsync(file)
    // Collect every file entry. Depth-independent on purpose: current ChatGPT
    // exports nest everything under a dated top-level folder, e.g.
    // "1716800000-ab12cd…/conversations.json", so the old exact-path lookup of
    // "conversations.json" / "data/conversations.json" missed entirely and the
    // user saw "no conversation file found" (mikes_pp, Discord 2026-06-07).
    const entries: Array<{ path: string; entry: JSZip.JSZipObject }> = []
    zip.forEach((path, entry) => { if (!entry.dir) entries.push({ path, entry }) })
    const basename = (p: string) => (p.split('/').pop() || '').toLowerCase()
    const isJson = (p: string) => p.toLowerCase().endsWith('.json')

    // 1) Prefer any file whose basename is exactly conversations.json, wherever
    //    it sits in the tree (handles the dated-folder nesting). Return the
    //    first that yields at least one conversation.
    for (const e of entries.filter(e => basename(e.path) === 'conversations.json')) {
      const text = await e.entry.async('string')
      const res = parseJsonText(text)
      if (res.conversations.length > 0) return res
    }
    // 2) Parse-and-pick: try every JSON file and keep whichever produces the
    //    most conversations. We deliberately do NOT rank by file size via
    //    JSZip's private `_data.uncompressedSize` — it is 0/undefined for many
    //    entries, which previously made the fallback grab user.json /
    //    message_feedback.json (→ 0 conversations) instead of the real export.
    let best: ParseResult | null = null
    for (const e of entries.filter(e => isJson(e.path))) {
      const text = await e.entry.async('string')
      const res = parseJsonText(text)
      if (res.conversations.length > 0 && (!best || res.conversations.length > best.conversations.length)) {
        best = res
      }
    }
    if (best) return best
    return { conversations: [], skipped: 0, detectedPlatform: 'unknown' }
  }
  // JSON path
  const text = await readFileAsText(file)
  return parseJsonText(text)
}

/** Convert a normalised conversation into a File the RAG uploader accepts. */
export function conversationToFile(conv: NormalisedConversation): File {
  const filename = `${conv.platform}_${conv.id}.md`
  const blob = new Blob([conv.markdown], { type: 'text/markdown' })
  return new File([blob], filename, { type: 'text/markdown' })
}
