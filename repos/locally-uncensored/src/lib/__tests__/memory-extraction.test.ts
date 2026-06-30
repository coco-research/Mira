import { describe, it, expect } from 'vitest'
import {
  buildExtractionPrompt,
  parseExtractionResponse,
  buildResolutionPrompt,
  parseResolutionResponse,
} from '../memory-extraction'

// ── buildExtractionPrompt ──────────────────────────────────────

describe('buildExtractionPrompt', () => {
  it('returns system + user message array', () => {
    const messages = buildExtractionPrompt('Hello', 'Hi there', '')
    expect(messages).toHaveLength(2)
    expect(messages[0].role).toBe('system')
    expect(messages[1].role).toBe('user')
  })

  it('system prompt contains all 4 memory types', () => {
    const messages = buildExtractionPrompt('test', 'test', '')
    const sys = messages[0].content
    expect(sys).toContain('user')
    expect(sys).toContain('feedback')
    expect(sys).toContain('project')
    expect(sys).toContain('reference')
  })

  it('includes existing memories summary in system prompt', () => {
    const existing = '- [user] Prefers dark mode\n- [project] Working on v2.0'
    const messages = buildExtractionPrompt('test', 'test', existing)
    expect(messages[0].content).toContain('Prefers dark mode')
    expect(messages[0].content).toContain('Working on v2.0')
  })

  it('shows "None yet." when no existing memories', () => {
    const messages = buildExtractionPrompt('test', 'test', '')
    expect(messages[0].content).toContain('None yet.')
  })

  it('user prompt contains user message and assistant response', () => {
    const messages = buildExtractionPrompt('What is React?', 'React is a JavaScript library...', '')
    const user = messages[1].content
    expect(user).toContain('What is React?')
    expect(user).toContain('React is a JavaScript library')
  })

  it('truncates long messages to 500 chars', () => {
    const longMsg = 'A'.repeat(1000)
    const messages = buildExtractionPrompt(longMsg, longMsg, '')
    const user = messages[1].content
    // Original was 1000 chars, should be truncated
    expect(user.length).toBeLessThan(1500)
  })
})

// ── parseExtractionResponse ────────────────────────────────────

describe('parseExtractionResponse', () => {
  it('parses valid JSON with shouldSave: true', () => {
    const response = '{"shouldSave": true, "memories": [{"type": "user", "title": "Dev role", "description": "User is a developer", "content": "The user is a software developer", "tags": ["role"]}]}'
    const result = parseExtractionResponse(response)
    expect(result.shouldSave).toBe(true)
    expect(result.memories).toHaveLength(1)
    expect(result.memories[0].type).toBe('user')
    expect(result.memories[0].title).toBe('Dev role')
    expect(result.memories[0].content).toBe('The user is a software developer')
    expect(result.memories[0].tags).toEqual(['role'])
  })

  it('parses shouldSave: false', () => {
    const result = parseExtractionResponse('{"shouldSave": false, "memories": []}')
    expect(result.shouldSave).toBe(false)
    expect(result.memories).toHaveLength(0)
  })

  it('handles JSON wrapped in markdown code block', () => {
    const response = 'Here is the analysis:\n```json\n{"shouldSave": true, "memories": [{"type": "feedback", "title": "No emojis", "content": "User does not want emojis", "tags": []}]}\n```'
    const result = parseExtractionResponse(response)
    expect(result.shouldSave).toBe(true)
    expect(result.memories[0].type).toBe('feedback')
  })

  it('handles JSON with preamble text', () => {
    const response = 'After analysis, I found:\n{"shouldSave": true, "memories": [{"type": "project", "title": "v2 migration", "content": "Working on v2", "tags": ["migration"]}]}'
    const result = parseExtractionResponse(response)
    expect(result.shouldSave).toBe(true)
    expect(result.memories[0].type).toBe('project')
  })

  it('returns fallback for garbage input', () => {
    expect(parseExtractionResponse('this is not json at all')).toEqual({ shouldSave: false, memories: [] })
    expect(parseExtractionResponse('')).toEqual({ shouldSave: false, memories: [] })
    expect(parseExtractionResponse('null')).toEqual({ shouldSave: false, memories: [] })
  })

  it('returns fallback for invalid JSON structure', () => {
    expect(parseExtractionResponse('{"foo": "bar"}')).toEqual({ shouldSave: false, memories: [] })
    expect(parseExtractionResponse('{"shouldSave": "yes"}')).toEqual({ shouldSave: false, memories: [] })
  })

  it('filters out memories with invalid type', () => {
    const response = '{"shouldSave": true, "memories": [{"type": "invalid_type", "title": "Bad", "content": "Bad type"}, {"type": "user", "title": "Good", "content": "Good type", "tags": []}]}'
    const result = parseExtractionResponse(response)
    expect(result.memories).toHaveLength(1)
    expect(result.memories[0].type).toBe('user')
  })

  it('filters out memories without title or content', () => {
    const response = '{"shouldSave": true, "memories": [{"type": "user", "title": "", "content": "No title"}, {"type": "user", "title": "No content", "content": ""}, {"type": "user", "title": "Valid", "content": "Valid content", "tags": []}]}'
    const result = parseExtractionResponse(response)
    expect(result.memories).toHaveLength(1)
    expect(result.memories[0].title).toBe('Valid')
  })

  it('truncates long titles to 60 chars', () => {
    const response = `{"shouldSave": true, "memories": [{"type": "user", "title": "${'A'.repeat(100)}", "content": "Test", "tags": []}]}`
    const result = parseExtractionResponse(response)
    expect(result.memories[0].title.length).toBeLessThanOrEqual(60)
  })

  it('truncates description to 120 chars', () => {
    const response = `{"shouldSave": true, "memories": [{"type": "user", "title": "Test", "description": "${'B'.repeat(200)}", "content": "Test", "tags": []}]}`
    const result = parseExtractionResponse(response)
    expect(result.memories[0].description.length).toBeLessThanOrEqual(120)
  })

  it('uses content as description fallback', () => {
    const response = '{"shouldSave": true, "memories": [{"type": "user", "title": "Test", "content": "Short content here", "tags": []}]}'
    const result = parseExtractionResponse(response)
    expect(result.memories[0].description).toBe('Short content here')
  })

  it('handles missing tags array gracefully', () => {
    const response = '{"shouldSave": true, "memories": [{"type": "user", "title": "Test", "content": "Content"}]}'
    const result = parseExtractionResponse(response)
    expect(result.memories[0].tags).toEqual([])
  })

  it('filters non-string tags', () => {
    const response = '{"shouldSave": true, "memories": [{"type": "user", "title": "Test", "content": "Content", "tags": ["valid", 123, null, "also_valid"]}]}'
    const result = parseExtractionResponse(response)
    expect(result.memories[0].tags).toEqual(['valid', 'also_valid'])
  })

  it('handles multiple valid memories', () => {
    const response = `{"shouldSave": true, "memories": [
      {"type": "user", "title": "Role", "content": "Developer", "tags": []},
      {"type": "feedback", "title": "Style", "content": "Prefers concise", "tags": []},
      {"type": "project", "title": "Goal", "content": "Building v2", "tags": []}
    ]}`
    const result = parseExtractionResponse(response)
    expect(result.memories).toHaveLength(3)
    expect(result.memories.map(m => m.type)).toEqual(['user', 'feedback', 'project'])
  })
})

// ── buildResolutionPrompt (Feature FF) ─────────────────────────

describe('buildResolutionPrompt', () => {
  it('returns system + user message array', () => {
    const messages = buildResolutionPrompt({ title: 'T', content: 'C' }, [])
    expect(messages).toHaveLength(2)
    expect(messages[0].role).toBe('system')
    expect(messages[1].role).toBe('user')
  })

  it('system prompt documents ADD / UPDATE / NOOP', () => {
    const sys = buildResolutionPrompt({ title: 'T', content: 'C' }, [])[0].content
    expect(sys).toContain('ADD')
    expect(sys).toContain('UPDATE')
    expect(sys).toContain('NOOP')
  })

  it('lists existing similar memories with their ids', () => {
    const messages = buildResolutionPrompt(
      { title: 'New', content: 'New content' },
      [
        { id: 'id-aaa', title: 'Old A', content: 'content A' },
        { id: 'id-bbb', title: 'Old B', content: 'content B' },
      ],
    )
    const sys = messages[0].content
    expect(sys).toContain('id-aaa')
    expect(sys).toContain('Old A')
    expect(sys).toContain('id-bbb')
  })

  it('shows "None." when there are no similar memories', () => {
    const sys = buildResolutionPrompt({ title: 'T', content: 'C' }, [])[0].content
    expect(sys).toContain('None.')
  })

  it('includes the new fact in the user message', () => {
    const user = buildResolutionPrompt({ title: 'Moved cities', content: 'User moved to Berlin' }, [])[1].content
    expect(user).toContain('Moved cities')
    expect(user).toContain('User moved to Berlin')
  })
})

// ── parseResolutionResponse (Feature FF) ───────────────────────

describe('parseResolutionResponse', () => {
  it('parses a plain ADD', () => {
    expect(parseResolutionResponse('{"action": "ADD"}')).toEqual({ action: 'ADD' })
  })

  it('parses NOOP', () => {
    expect(parseResolutionResponse('{"action": "NOOP"}')).toEqual({ action: 'NOOP' })
  })

  it('parses a valid UPDATE with targetId + mergedContent', () => {
    const r = parseResolutionResponse('{"action": "UPDATE", "targetId": "id-1", "mergedContent": "merged text"}')
    expect(r).toEqual({ action: 'UPDATE', targetId: 'id-1', mergedContent: 'merged text' })
  })

  it('is case-insensitive on the action', () => {
    expect(parseResolutionResponse('{"action": "noop"}').action).toBe('NOOP')
    expect(parseResolutionResponse('{"action": "update", "targetId": "x", "mergedContent": "y"}').action).toBe('UPDATE')
  })

  it('strips markdown code fences', () => {
    const r = parseResolutionResponse('```json\n{"action": "NOOP"}\n```')
    expect(r.action).toBe('NOOP')
  })

  it('handles preamble text before the JSON', () => {
    const r = parseResolutionResponse('Here is my decision:\n{"action": "ADD"}')
    expect(r.action).toBe('ADD')
  })

  it('downgrades UPDATE to ADD when targetId is missing', () => {
    expect(parseResolutionResponse('{"action": "UPDATE", "mergedContent": "x"}')).toEqual({ action: 'ADD' })
  })

  it('downgrades UPDATE to ADD when mergedContent is missing/empty', () => {
    expect(parseResolutionResponse('{"action": "UPDATE", "targetId": "id-1"}')).toEqual({ action: 'ADD' })
    expect(parseResolutionResponse('{"action": "UPDATE", "targetId": "id-1", "mergedContent": "  "}')).toEqual({ action: 'ADD' })
  })

  it('rejects an UPDATE targetId not in the validIds allowlist', () => {
    const r = parseResolutionResponse(
      '{"action": "UPDATE", "targetId": "rogue", "mergedContent": "x"}',
      ['id-1', 'id-2'],
    )
    expect(r).toEqual({ action: 'ADD' })
  })

  it('accepts an UPDATE targetId that IS in the allowlist', () => {
    const r = parseResolutionResponse(
      '{"action": "UPDATE", "targetId": "id-2", "mergedContent": "merged"}',
      ['id-1', 'id-2'],
    )
    expect(r).toEqual({ action: 'UPDATE', targetId: 'id-2', mergedContent: 'merged' })
  })

  it('falls back to ADD on garbage / unknown action', () => {
    expect(parseResolutionResponse('not json')).toEqual({ action: 'ADD' })
    expect(parseResolutionResponse('')).toEqual({ action: 'ADD' })
    expect(parseResolutionResponse('{"action": "DELETE"}')).toEqual({ action: 'ADD' })
    expect(parseResolutionResponse('{"foo": "bar"}')).toEqual({ action: 'ADD' })
  })
})
