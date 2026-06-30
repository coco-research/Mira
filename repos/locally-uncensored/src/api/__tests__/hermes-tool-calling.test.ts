import { describe, it, expect } from 'vitest'
import {
  buildHermesToolPrompt,
  buildHermesToolResult,
  parseHermesToolCalls,
  stripToolCallTags,
  hasToolCallTags,
} from '../hermes-tool-calling'
import type { AgentToolDef } from '../../types/agent-mode'

// ── Helpers ─────────────────────────────────────────────────────

const makeTool = (name: string, desc = 'A tool'): AgentToolDef => ({
  name,
  description: desc,
  parameters: {
    type: 'object',
    properties: {
      input: { type: 'string', description: 'Some input' },
    },
    required: ['input'],
  },
  permission: 'auto',
})

// ── buildHermesToolPrompt ───────────────────────────────────────

describe('buildHermesToolPrompt', () => {
  it('wraps tool definitions inside <tools> XML tags', () => {
    const prompt = buildHermesToolPrompt([makeTool('web_search')])
    expect(prompt).toContain('<tools>')
    expect(prompt).toContain('</tools>')
    expect(prompt).toContain('"web_search"')
  })

  it('includes every tool in the output', () => {
    const tools = [makeTool('web_search'), makeTool('file_read'), makeTool('code_execute')]
    const prompt = buildHermesToolPrompt(tools)
    expect(prompt).toContain('"web_search"')
    expect(prompt).toContain('"file_read"')
    expect(prompt).toContain('"code_execute"')
  })

  it('produces valid JSON for each tool definition', () => {
    const prompt = buildHermesToolPrompt([makeTool('alpha')])
    const match = prompt.match(/<tools>\n([\s\S]*?)\n<\/tools>/)
    expect(match).toBeTruthy()
    const parsed = JSON.parse(match![1])
    expect(parsed.type).toBe('function')
    expect(parsed.function.name).toBe('alpha')
    expect(parsed.function.parameters).toBeDefined()
  })

  it('returns valid prompt with empty tools array', () => {
    const prompt = buildHermesToolPrompt([])
    expect(prompt).toContain('<tools>')
    expect(prompt).toContain('</tools>')
    // Should still contain the system instructions
    expect(prompt).toContain('function calling AI model')
  })

  it('includes <tool_call> usage instructions', () => {
    const prompt = buildHermesToolPrompt([makeTool('x')])
    expect(prompt).toContain('<tool_call>')
    expect(prompt).toContain('</tool_call>')
  })
})

// ── buildHermesToolResult ───────────────────────────────────────

describe('buildHermesToolResult', () => {
  it('wraps the result in <tool_response> tags', () => {
    const result = buildHermesToolResult('web_search', 'found something')
    expect(result).toContain('<tool_response>')
    expect(result).toContain('</tool_response>')
  })

  it('includes the tool name in the output', () => {
    const result = buildHermesToolResult('file_read', 'content here')
    expect(result).toContain('"file_read"')
  })

  it('JSON-stringifies the content (handles special characters)', () => {
    const result = buildHermesToolResult('test', 'line1\nline2\ttab "quoted"')
    expect(result).toContain('"content"')
    // The result string should be valid JSON-encoded
    const match = result.match(/<tool_response>\n([\s\S]*?)\n<\/tool_response>/)
    expect(match).toBeTruthy()
    const parsed = JSON.parse(match![1])
    expect(parsed.name).toBe('test')
    expect(parsed.content).toBe('line1\nline2\ttab "quoted"')
  })

  it('handles empty result string', () => {
    const result = buildHermesToolResult('empty', '')
    const match = result.match(/<tool_response>\n([\s\S]*?)\n<\/tool_response>/)
    const parsed = JSON.parse(match![1])
    expect(parsed.content).toBe('')
  })
})

// ── parseHermesToolCalls ────────────────────────────────────────

describe('parseHermesToolCalls', () => {
  it('parses a single tool call', () => {
    const output = '<tool_call>\n{"name": "web_search", "arguments": {"query": "hello"}}\n</tool_call>'
    const calls = parseHermesToolCalls(output)
    expect(calls).toHaveLength(1)
    expect(calls[0].name).toBe('web_search')
    expect(calls[0].arguments).toEqual({ query: 'hello' })
  })

  it('parses multiple tool calls', () => {
    const output = `Some text
<tool_call>
{"name": "web_search", "arguments": {"query": "a"}}
</tool_call>
middle text
<tool_call>
{"name": "file_read", "arguments": {"path": "/tmp/x"}}
</tool_call>`
    const calls = parseHermesToolCalls(output)
    expect(calls).toHaveLength(2)
    expect(calls[0].name).toBe('web_search')
    expect(calls[1].name).toBe('file_read')
    expect(calls[1].arguments).toEqual({ path: '/tmp/x' })
  })

  it('returns empty array when no tags present', () => {
    expect(parseHermesToolCalls('just plain text')).toEqual([])
    expect(parseHermesToolCalls('')).toEqual([])
  })

  it('handles malformed JSON with regex fallback (extracts name)', () => {
    const output = '<tool_call>\n{"name": "web_search", broken json here}\n</tool_call>'
    const calls = parseHermesToolCalls(output)
    expect(calls).toHaveLength(1)
    expect(calls[0].name).toBe('web_search')
    expect(calls[0].arguments).toEqual({})
  })

  it('handles malformed JSON with regex fallback (extracts name + arguments)', () => {
    const output = '<tool_call>\n{"name": "file_read", "arguments": {"path": "/x"}, trailing}\n</tool_call>'
    const calls = parseHermesToolCalls(output)
    expect(calls).toHaveLength(1)
    expect(calls[0].name).toBe('file_read')
    expect(calls[0].arguments).toEqual({ path: '/x' })
  })

  it('skips tool_call tags with no valid name', () => {
    const output = '<tool_call>\n{"invalid": true}\n</tool_call>'
    const calls = parseHermesToolCalls(output)
    expect(calls).toHaveLength(0)
  })

  it('handles mixed content with tool calls and plain text', () => {
    const output = 'Let me search for that.\n<tool_call>\n{"name": "web_search", "arguments": {"query": "test"}}\n</tool_call>\nHere are the results.'
    const calls = parseHermesToolCalls(output)
    expect(calls).toHaveLength(1)
    expect(calls[0].name).toBe('web_search')
  })

  it('supports "parameters" key as alias for "arguments"', () => {
    const output = '<tool_call>\n{"name": "web_search", "parameters": {"query": "test"}}\n</tool_call>'
    const calls = parseHermesToolCalls(output)
    expect(calls).toHaveLength(1)
    expect(calls[0].arguments).toEqual({ query: 'test' })
  })

  it('defaults arguments to empty object when missing', () => {
    const output = '<tool_call>\n{"name": "web_search"}\n</tool_call>'
    const calls = parseHermesToolCalls(output)
    expect(calls).toHaveLength(1)
    expect(calls[0].arguments).toEqual({})
  })
})

// ── stripToolCallTags ───────────────────────────────────────────

describe('stripToolCallTags', () => {
  it('removes tool_call tags and their content', () => {
    const output = 'before <tool_call>{"name":"x"}</tool_call> after'
    expect(stripToolCallTags(output)).toBe('before  after')
  })

  it('removes tool_response tags and their content', () => {
    const output = 'start <tool_response>{"name":"y","content":"z"}</tool_response> end'
    expect(stripToolCallTags(output)).toBe('start  end')
  })

  it('removes multiple tags', () => {
    const output = 'a <tool_call>1</tool_call> b <tool_call>2</tool_call> c'
    expect(stripToolCallTags(output)).toBe('a  b  c')
  })

  it('returns empty string for empty input', () => {
    expect(stripToolCallTags('')).toBe('')
  })

  it('returns original content when no tags present', () => {
    expect(stripToolCallTags('no tags here')).toBe('no tags here')
  })

  it('trims whitespace from the result', () => {
    const output = '  <tool_call>x</tool_call>  '
    expect(stripToolCallTags(output)).toBe('')
  })
})

// ── hasToolCallTags ─────────────────────────────────────────────

describe('hasToolCallTags', () => {
  it('returns true when tool_call tags are present', () => {
    expect(hasToolCallTags('<tool_call>{"name":"x"}</tool_call>')).toBe(true)
  })

  it('returns true for partial/opening tag (model still streaming)', () => {
    expect(hasToolCallTags('some text <tool_call>')).toBe(true)
  })

  it('returns false for empty string', () => {
    expect(hasToolCallTags('')).toBe(false)
  })

  it('returns false when no tags present', () => {
    expect(hasToolCallTags('just normal text')).toBe(false)
  })

  it('returns false for tool_response tags (only checks tool_call)', () => {
    expect(hasToolCallTags('<tool_response>data</tool_response>')).toBe(false)
  })
})
