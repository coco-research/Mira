/**
 * Chat Export Tests
 * Run: npx vitest run src/lib/__tests__/chat-export.test.ts
 */
import { describe, it, expect } from 'vitest'
import { exportAsMarkdown, exportAsJSON } from '../chat-export'
import type { Conversation } from '../../types/chat'

const mockConversation: Conversation = {
  id: 'test-123',
  title: 'Test Chat',
  model: 'hermes3:8b',
  systemPrompt: 'You are a helpful assistant.',
  createdAt: 1712160000000,
  updatedAt: 1712160000000,
  messages: [
    { id: 'm1', role: 'user', content: 'Hello!', timestamp: 1712160001000 },
    { id: 'm2', role: 'assistant', content: 'Hi there!', timestamp: 1712160002000, thinking: 'User said hello, I should greet back.' },
    { id: 'm3', role: 'user', content: 'What is 2+2?', timestamp: 1712160003000 },
    { id: 'm4', role: 'assistant', content: 'The answer is 4.', timestamp: 1712160004000, toolCallSummary: 'calculator(2+2) = 4', sources: [{ documentName: 'math.pdf', chunkIndex: 0, preview: 'Basic arithmetic' }] },
  ],
}

describe('exportAsMarkdown', () => {
  it('includes title and model', () => {
    const md = exportAsMarkdown(mockConversation)
    expect(md).toContain('# Test Chat')
    expect(md).toContain('hermes3:8b')
  })

  it('includes system prompt', () => {
    const md = exportAsMarkdown(mockConversation)
    expect(md).toContain('## System Prompt')
    expect(md).toContain('You are a helpful assistant.')
  })

  it('includes all messages with roles', () => {
    const md = exportAsMarkdown(mockConversation)
    expect(md).toContain('### You')
    expect(md).toContain('### Assistant')
    expect(md).toContain('Hello!')
    expect(md).toContain('Hi there!')
    expect(md).toContain('The answer is 4.')
  })

  it('includes thinking blocks', () => {
    const md = exportAsMarkdown(mockConversation)
    expect(md).toContain('Thinking')
    expect(md).toContain('User said hello')
  })

  it('includes tool call summaries', () => {
    const md = exportAsMarkdown(mockConversation)
    expect(md).toContain('calculator(2+2) = 4')
  })

  it('includes RAG sources', () => {
    const md = exportAsMarkdown(mockConversation)
    expect(md).toContain('math.pdf')
  })

  it('handles conversation without system prompt', () => {
    const conv = { ...mockConversation, systemPrompt: '' }
    const md = exportAsMarkdown(conv)
    expect(md).not.toContain('## System Prompt')
  })
})

describe('exportAsJSON', () => {
  it('returns valid JSON', () => {
    const json = exportAsJSON(mockConversation)
    const parsed = JSON.parse(json)
    expect(parsed.id).toBe('test-123')
    expect(parsed.messages).toHaveLength(4)
  })

  it('preserves all fields', () => {
    const json = exportAsJSON(mockConversation)
    const parsed = JSON.parse(json)
    expect(parsed.title).toBe('Test Chat')
    expect(parsed.model).toBe('hermes3:8b')
    expect(parsed.messages[1].thinking).toBe('User said hello, I should greet back.')
    expect(parsed.messages[3].sources).toHaveLength(1)
  })
})
