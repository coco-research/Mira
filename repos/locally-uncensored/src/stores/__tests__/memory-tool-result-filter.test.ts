/**
 * Thought-only empty-reply fix (live find 2026-06-11, David: "siehst du
 * überhaupt das die ganze zeit keine antwort kommt?").
 *
 * Root cause chain, proven by replaying LU's exact /api/chat body: the memory
 * system injected remembered TOOL RESULTS ("web_search result: web_search({…})
 * → …") into a PLAIN chat's system prompt. gemma4 read them as worked
 * examples, spent the whole turn in its native thinking channel deciding to
 * "use the web_search tool", emitted ZERO content (content_len: 0,
 * thinking_len: 192, done_reason: stop) — and the user stared at a silent
 * empty bubble with no banner (the Enable-Agent nudge required content).
 *
 * These tests pin the three fix layers:
 *  1. isToolResultMemory — recognizes the extractor's "<tool> result:" shape
 *  2. getMemoriesForPrompt({excludeToolResults}) — plain chats drop them,
 *     agent chats (no flag) keep them
 *  3. looksLikeToolIntent — detects tool intent in captured reasoning so the
 *     bubble can render the Enable-Agent banner instead of dead air
 *
 * Run: npx vitest run src/stores/__tests__/memory-tool-result-filter.test.ts
 */
import { describe, it, expect, beforeEach } from 'vitest'
import { useMemoryStore, isToolResultMemory } from '../memoryStore'
import { looksLikeToolIntent } from '../../lib/tool-call-repair'

const TOOL_RESULT_CONTENT =
  'web_search result: web_search({"query":"latest stable Ollama release version"}) → 1. Releases · ollama/ollama - GitHub'

function seed(entries: Array<{ title: string; content: string; type?: 'user' | 'feedback' | 'project' | 'reference' }>) {
  const store = useMemoryStore.getState()
  store.clearAll()
  for (const e of entries) {
    store.addMemory({
      title: e.title,
      description: e.content.slice(0, 80),
      content: e.content,
      type: e.type ?? 'reference',
      tags: [],
    } as never)
  }
}

describe('isToolResultMemory', () => {
  it('matches the extractor\'s "<tool> result:" shape (content or title)', () => {
    expect(isToolResultMemory({ title: 'web_search result', content: TOOL_RESULT_CONTENT })).toBe(true)
    expect(isToolResultMemory({ title: 'video_generate result', content: 'video_generate result: Video generated: x.mp4' })).toBe(true)
    expect(isToolResultMemory({ title: 'shell output', content: 'shell_execute result: Command executed successfully.' })).toBe(true)
  })
  it('does NOT match ordinary memories', () => {
    expect(isToolResultMemory({ title: 'User preference', content: 'David prefers German conversation and English code.' })).toBe(false)
    expect(isToolResultMemory({ title: 'Red Apple animation specs', content: 'The desired output is a 3-second video featuring gentle motion.' })).toBe(false)
    // "results" as a normal word is not the marker
    expect(isToolResultMemory({ title: 'Benchmark', content: 'The test results: all green.' })).toBe(false)
  })
})

describe('getMemoriesForPrompt — excludeToolResults', () => {
  beforeEach(() => {
    seed([
      { title: 'web_search result', content: TOOL_RESULT_CONTENT },
      { title: 'Red Apple animation specs', content: 'Red apple still life: the latest stable render uses gentle motion and a glossy texture.' },
    ])
  })

  it('plain chats (flag set) drop tool-result memories but keep normal ones', () => {
    const out = useMemoryStore.getState().getMemoriesForPrompt('latest stable version search', 16384, { excludeToolResults: true })
    expect(out).not.toContain('web_search result')
    expect(out).toContain('Red Apple')
  })

  it('agent path (no flag) keeps tool-result memories (tools exist there)', () => {
    const out = useMemoryStore.getState().getMemoriesForPrompt('latest stable version search', 16384)
    expect(out).toContain('web_search result')
  })
})

describe('looksLikeToolIntent — reasoning that wants a tool', () => {
  it('matches gemma\'s replayed thought-only reasoning verbatim', () => {
    const replayedThinking =
      'The user is repeatedly asking to search the web for the "latest stable Python version" and wants the answer in one short sentence. I need to use the `web_search` tool to find this information.'
    expect(looksLikeToolIntent(replayedThinking)).toBe(true)
  })
  it('matches structured call shapes', () => {
    expect(looksLikeToolIntent('I will call image_generate({"prompt": "a red apple"}) now.')).toBe(true)
    expect(looksLikeToolIntent('<tool_call>{"name":"web_search","arguments":{"query":"x"}}</tool_call>')).toBe(true)
  })
  it('does not fire on ordinary reasoning or empty text', () => {
    expect(looksLikeToolIntent('The capital of Iceland is Reykjavík, which I know directly.')).toBe(false)
    expect(looksLikeToolIntent('')).toBe(false)
  })
})
