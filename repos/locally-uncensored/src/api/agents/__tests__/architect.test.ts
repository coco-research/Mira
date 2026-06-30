import { describe, it, expect, vi, beforeEach } from 'vitest'

const chatWithTools = vi.fn()

vi.mock('../../providers', () => ({
  getProviderForModel: (name: string) => ({
    provider: { chatWithTools },
    modelId: name.includes('::') ? name.split('::')[1] : name,
  }),
}))

import {
  planWithArchitect,
  renderArchitectPlanSection,
  ARCHITECT_SYSTEM_PROMPT,
} from '../architect'

describe('architect — renderArchitectPlanSection', () => {
  it('returns empty string for empty / whitespace plans', () => {
    expect(renderArchitectPlanSection('')).toBe('')
    expect(renderArchitectPlanSection('   \n  ')).toBe('')
  })

  it('wraps the plan in a marker the editor can anchor on', () => {
    const out = renderArchitectPlanSection('## Plan\n1. Do X')
    expect(out).toMatch(/^\n\nARCHITECT PLAN/)
    expect(out).toMatch(/Do X/)
  })

  it('trims surrounding whitespace from the plan', () => {
    const out = renderArchitectPlanSection('\n\n  ## Plan  \n\n')
    expect(out).toMatch(/## Plan/)
    expect(out.endsWith('  ')).toBe(false)
  })
})

describe('architect — planWithArchitect', () => {
  beforeEach(() => {
    chatWithTools.mockReset()
  })

  it('calls the provider with an empty tools array', async () => {
    chatWithTools.mockResolvedValueOnce({ content: 'plan body', toolCalls: [] })
    await planWithArchitect({
      model: 'anthropic::claude-sonnet-4-5',
      userInstruction: 'add a button',
      workingDirectory: '/tmp/repo',
    })
    expect(chatWithTools).toHaveBeenCalledOnce()
    const [, , tools] = chatWithTools.mock.calls[0]
    expect(tools).toEqual([])
  })

  it('threads workingDirectory into the system prompt', async () => {
    chatWithTools.mockResolvedValueOnce({ content: 'plan body', toolCalls: [] })
    await planWithArchitect({
      model: 'ollama::qwen2.5-coder:32b',
      userInstruction: 'refactor X',
      workingDirectory: '/Users/me/repo',
    })
    const [, messages] = chatWithTools.mock.calls[0]
    expect(messages[0].role).toBe('system')
    expect(messages[0].content).toContain(ARCHITECT_SYSTEM_PROMPT)
    expect(messages[0].content).toContain('Working directory: /Users/me/repo')
  })

  it('places the user instruction as the final message', async () => {
    chatWithTools.mockResolvedValueOnce({ content: 'plan body', toolCalls: [] })
    await planWithArchitect({
      model: 'anthropic::claude-sonnet-4-5',
      userInstruction: 'add a button',
      workingDirectory: '/tmp/repo',
    })
    const [, messages] = chatWithTools.mock.calls[0]
    const last = messages[messages.length - 1]
    expect(last).toEqual({ role: 'user', content: 'add a button' })
  })

  it('includes recent messages between system and user', async () => {
    chatWithTools.mockResolvedValueOnce({ content: 'plan body', toolCalls: [] })
    await planWithArchitect({
      model: 'anthropic::claude-sonnet-4-5',
      userInstruction: 'continue',
      workingDirectory: '/tmp/repo',
      recentMessages: [
        { role: 'user', content: 'earlier question' },
        { role: 'assistant', content: 'earlier answer' },
      ],
    })
    const [, messages] = chatWithTools.mock.calls[0]
    expect(messages).toHaveLength(4) // system + 2 history + user
    expect(messages[1].content).toBe('earlier question')
    expect(messages[2].content).toBe('earlier answer')
  })

  it('defaults to deterministic temperature for plan stability', async () => {
    chatWithTools.mockResolvedValueOnce({ content: 'plan body', toolCalls: [] })
    await planWithArchitect({
      model: 'anthropic::claude-sonnet-4-5',
      userInstruction: 'do',
      workingDirectory: '/tmp',
    })
    const [, , , options] = chatWithTools.mock.calls[0]
    expect(options.temperature).toBe(0.3)
  })

  it('passes through a caller-supplied temperature override', async () => {
    chatWithTools.mockResolvedValueOnce({ content: 'plan body', toolCalls: [] })
    await planWithArchitect({
      model: 'anthropic::claude-sonnet-4-5',
      userInstruction: 'do',
      workingDirectory: '/tmp',
      temperature: 0.9,
    })
    const [, , , options] = chatWithTools.mock.calls[0]
    expect(options.temperature).toBe(0.9)
  })

  it('trims the returned plan', async () => {
    chatWithTools.mockResolvedValueOnce({ content: '  \n## Plan\n  ', toolCalls: [] })
    const result = await planWithArchitect({
      model: 'm',
      userInstruction: 'i',
      workingDirectory: '/',
    })
    expect(result.plan).toBe('## Plan')
  })

  it('echoes the chosen model name in the result', async () => {
    chatWithTools.mockResolvedValueOnce({ content: 'p', toolCalls: [] })
    const result = await planWithArchitect({
      model: 'anthropic::claude-opus-4-1',
      userInstruction: 'i',
      workingDirectory: '/',
    })
    expect(result.modelUsed).toBe('anthropic::claude-opus-4-1')
  })

  it('reports wall time as tookMs', async () => {
    chatWithTools.mockImplementationOnce(async () => {
      await new Promise((r) => setTimeout(r, 5))
      return { content: 'p', toolCalls: [] }
    })
    const result = await planWithArchitect({
      model: 'm',
      userInstruction: 'i',
      workingDirectory: '/',
    })
    expect(result.tookMs).toBeGreaterThanOrEqual(0)
  })

  it('handles null/undefined content from the provider as an empty plan', async () => {
    chatWithTools.mockResolvedValueOnce({ content: null, toolCalls: [] })
    const result = await planWithArchitect({
      model: 'm',
      userInstruction: 'i',
      workingDirectory: '/',
    })
    expect(result.plan).toBe('')
  })

  it('propagates the AbortSignal to the provider', async () => {
    chatWithTools.mockResolvedValueOnce({ content: 'p', toolCalls: [] })
    const ctrl = new AbortController()
    await planWithArchitect({
      model: 'm',
      userInstruction: 'i',
      workingDirectory: '/',
      signal: ctrl.signal,
    })
    const [, , , options] = chatWithTools.mock.calls[0]
    expect(options.signal).toBe(ctrl.signal)
  })
})
