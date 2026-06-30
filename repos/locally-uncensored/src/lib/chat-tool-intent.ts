/**
 * Curated tools in PLAIN chat (David 2026-06-11: "web search web fetch file
 * write und image und video mcp sollen auch im normalen chat funktionieren").
 *
 * Plain chat should be able to reach a small, fixed set of capabilities WITHOUT
 * the user flipping the full Agent toggle. Rather than expose every agent tool
 * on every message (which degrades pure conversation and over-triggers small
 * models), we detect when a message clearly needs one of these five
 * capabilities and route just that turn through the agent executor with a
 * curated allow-list + a chat-style prompt. Everything else stays on the fast
 * plain-chat path, untouched.
 *
 * The detector is intentionally capability-specific: a greeting, an
 * explanation request, or normal Q&A must NOT match (otherwise every message
 * would route through the tool loop). It errs toward the concrete signals a
 * user gives when they actually want a web lookup, a file written, or an
 * image/video made — in both English and German.
 */

/** The exact tools surfaced in plain chat. Order is irrelevant. */
export const CHAT_TOOLS = [
  'web_search',
  'web_fetch',
  'file_write',
  'image_generate',
  'video_generate',
] as const

export type ChatToolCapability = 'image' | 'video' | 'web' | 'file'

const lower = (s: string) => (s || '').toLowerCase()

// A bare URL or an explicit "open/read this page" → web_fetch territory.
const URL_RE = /\bhttps?:\/\/\S+|\bwww\.\S+|\b[a-z0-9-]+\.(com|org|net|io|dev|ai|de|co|gov|edu|app|news)\b(\/\S*)?/i
const FETCH_VERB_RE = /\b(open|read|fetch|scrape|summari[sz]e|summari[sz]e|get|öffne|lies|lese|fasse|zusammenfass\w*|ruf\w*\s+auf)\b[^.?!]*\b(page|site|website|link|url|article|seite|webseite|link|url|artikel)\b/i

// Search intent: explicit search verbs, or a freshness/lookup signal that a
// model cannot answer reliably from training memory.
const SEARCH_VERB_RE = /\b(search|google|look\s*up|web\s*search|search\s+the\s+web|such(e|en)?|google(n|st)?|recherchier\w*|nachschlagen|find\s+(online|on\s+the\s+web))\b/i
// Freshness only triggers a search when it modifies a lookup-ish noun — bare
// "today"/"now" in conversational phrasing ("how are you today") must not.
const FRESHNESS_RE = /\b(latest|newest|current(ly)?|today'?s?|tonight|right\s+now|recent(ly)?|breaking|in\s+20\d\d|as\s+of\s+(today|now)|aktuell\w*|neueste\w*|heutige\w*)\b/i
const FRESH_TOPIC_RE = /\b(version|release|update|news|results?|winner|champion|election|launch|price|prices|stock|standings|score|scores|ranking|patch|driver(s)?|model(s)?|treiber)\b/i
const LOOKUP_TOPIC_RE = /\b(weather|temperature|forecast|price\s+of|stock\s+price|exchange\s+rate|who\s+won|who\s+is\s+winning|standings|release\s+date|wetter|preis\s+von|kurs\s+von|wer\s+hat\s+gewonnen|wechselkurs)\b/i

// Verbs that inherently mean "make an image" even without a media noun
// ("draw a cat", "zeichne eine Blume").
const INHERENT_IMAGE_VERB_RE = /\b(draw|sketch|paint|illustrate|mal(e|en)?|zeichne(n|st)?|skizzier\w*)\b/i

// Image / video creation: a creation verb co-occurring with a media noun.
const CREATE_VERB_RE = /\b(draw|sketch|paint|generate|create|make|render|design|give\s+me|show\s+me|produce|turn|convert|mal(e|en)?|zeichne|erstell(e|en)?|generier(e|en)?|mach(e|en)?|gib\s+mir|zeig(e|en)?\s+mir|entwirf|produzier(e|en)?|verwandle|wandle)\b/i
const IMAGE_NOUN_RE = /\b(image|picture|pic|photo(graph)?|drawing|art(work)?|illustration|portrait|wallpaper|logo|icon|render|painting|bild(er)?|foto(s)?|grafik(en)?|zeichnung(en)?|gem[äa]lde|portr[äa]t|illustration(en)?)\b/i
const VIDEO_NOUN_RE = /\b(video|clip|animation|movie|gif|film|animier\w*|animate)\b/i
const ANIMATE_RE = /\banimate\b[^.?!]*\b(image|picture|photo|it|this|that)\b|\banimier\w*\b[^.?!]*\b(bild|foto|es|das)\b/i

// File creation: a write/save verb co-occurring with a file noun or an explicit
// filename + extension.
const FILE_VERB_RE = /\b(write|save|create|generate|put|export|dump|store|schreib(e|en)?|speicher(e|n|st)?|erstell(e|en)?|leg\w*\s+an|exportier(e|en)?|sichere)\b/i
const FILE_NOUN_RE = /\b(a\s+|an\s+|the\s+|eine?\s+|die\s+)?(file|files|datei(en)?|textfile|text\s+file|markdown|csv|json\s+file)\b/i
const FILENAME_RE = /\b[\w.-]+\.(txt|md|markdown|html?|css|js|ts|json|csv|xml|yaml|yml|py|sh|rs|toml|ini|log|svg|sql)\b/i
const SAVE_TO_FILE_RE = /\b(save|write|export|dump|speicher\w*|schreib\w*)\b[^.?!]*\b(to|into|as|in)\b[^.?!]*\b(file|datei|disk|\.\w{1,5})\b/i

/**
 * Returns the capability a plain-chat message is asking for, or null if the
 * message is ordinary conversation that should stay on the plain path.
 * `hasImages` is true when the user attached an image — slightly biases the
 * media branch toward video (animate-this-image) but is not required.
 */
export function detectChatToolCapability(text: string, hasImages = false): ChatToolCapability | null {
  const t = lower(text).trim()
  if (!t) return null

  // VIDEO first (a video request often also contains an image-ish noun like
  // "animate this picture into a video"; resolving video first avoids
  // misrouting those to image generation).
  if (CREATE_VERB_RE.test(t) && VIDEO_NOUN_RE.test(t)) return 'video'
  if (ANIMATE_RE.test(t)) return 'video'
  if (hasImages && /\b(animate|animier\w*|bring\s+to\s+life|make\s+it\s+move|in\s+ein\s+video)\b/i.test(t)) return 'video'

  // IMAGE
  if (CREATE_VERB_RE.test(t) && IMAGE_NOUN_RE.test(t)) return 'image'
  if (INHERENT_IMAGE_VERB_RE.test(t)) return 'image'

  // FILE WRITE
  if (FILENAME_RE.test(t) && FILE_VERB_RE.test(t)) return 'file'
  if (SAVE_TO_FILE_RE.test(t)) return 'file'
  if (FILE_VERB_RE.test(t) && FILE_NOUN_RE.test(t)) return 'file'

  // WEB FETCH (explicit page/url) — before generic search so a URL routes to
  // fetch, not search.
  if (FETCH_VERB_RE.test(t)) return 'web'
  if (URL_RE.test(t) && /\b(open|read|fetch|summari[sz]e|get|check|visit|öffne|lies|lese|fasse|besuche|schau)\b/i.test(t)) return 'web'

  // WEB SEARCH
  if (SEARCH_VERB_RE.test(t)) return 'web'
  if (LOOKUP_TOPIC_RE.test(t)) return 'web'
  // Freshness only counts when it actually modifies a lookup-ish topic, so
  // "what is the latest python version" routes but "how are you today" does not.
  if (FRESHNESS_RE.test(t) && FRESH_TOPIC_RE.test(t)) return 'web'

  return null
}

/** Convenience boolean wrapper for the router in useChat. */
export function detectChatToolIntent(text: string, hasImages = false): boolean {
  return detectChatToolCapability(text, hasImages) !== null
}
