import { describe, it, expect, beforeEach } from 'vitest'
import {
  setChatArtifactMode,
  isChatArtifactMode,
  captureChatArtifact,
  takeChatArtifacts,
  clearActiveChatId,
} from '../agent-context'

// David 2026-06-12: in plain chat, file_write captures here (ChatGPT-style
// in-chat artifact) instead of touching disk. These lock the capture/drain/reset
// contract that useAgentChat + executeFileWrite rely on.
describe('chat-tools artifact context', () => {
  beforeEach(() => clearActiveChatId())

  it('is off by default', () => {
    expect(isChatArtifactMode()).toBe(false)
  })

  it('captures artifacts in order and drains them once', () => {
    setChatArtifactMode(true)
    expect(isChatArtifactMode()).toBe(true)
    captureChatArtifact('a.md', '# A', 'text/markdown')
    captureChatArtifact('b.txt', 'B', 'text/plain')
    expect(takeChatArtifacts()).toEqual([
      { name: 'a.md', content: '# A', mime: 'text/markdown' },
      { name: 'b.txt', content: 'B', mime: 'text/plain' },
    ])
    // Drained — a second take is empty (so artifacts attach to exactly one turn).
    expect(takeChatArtifacts()).toEqual([])
  })

  it('turning the mode OFF clears any pending captures', () => {
    setChatArtifactMode(true)
    captureChatArtifact('x.txt', 'x', 'text/plain')
    setChatArtifactMode(false)
    expect(isChatArtifactMode()).toBe(false)
    expect(takeChatArtifacts()).toEqual([])
  })

  it('clearActiveChatId resets mode + captures (per-run cleanup)', () => {
    setChatArtifactMode(true)
    captureChatArtifact('y.txt', 'y', 'text/plain')
    clearActiveChatId()
    expect(isChatArtifactMode()).toBe(false)
    expect(takeChatArtifacts()).toEqual([])
  })
})
