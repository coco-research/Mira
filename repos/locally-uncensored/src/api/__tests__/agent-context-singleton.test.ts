/**
 * agent-context duplication guard (v2.5.3 live E2E find, 2026-06-11).
 *
 * The rolldown-based production build DUPLICATED the agent-context module:
 * the App chunk inlined one copy (written by useAgentChat/useCodex) while the
 * dynamically imported mcp/vram-handoff graph read the separate chunk's copy
 * — so getActiveAgentModel() was always null in the release app and VRAM
 * eviction silently never ran (proven via live console capture + the `noid`
 * literal appearing in two dist chunks).
 *
 * The fix parks the mutable state on `globalThis.__LU_AGENT_CTX`. These tests
 * simulate "two bundled copies" with vi.resetModules() + a fresh dynamic
 * import: a SECOND module instance must see state written by the FIRST.
 *
 * Run: npx vitest run src/api/__tests__/agent-context-singleton.test.ts
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'

type AgentContextModule = typeof import('../agent-context')

async function freshCopy(): Promise<AgentContextModule> {
  vi.resetModules()
  return (await import('../agent-context')) as AgentContextModule
}

beforeEach(async () => {
  // Start every test from a clean carrier, whatever earlier tests did.
  delete (globalThis as Record<string, unknown>).__LU_AGENT_CTX
})

describe('agent-context state survives module duplication', () => {
  it('a second module copy sees the agent model pinned by the first', async () => {
    const copyA = await freshCopy()
    copyA.setActiveAgentModel({ name: 'gemma4:e4b', providerId: 'ollama', remote: false })

    const copyB = await freshCopy()
    expect(copyB.getActiveAgentModel()).toEqual({
      name: 'gemma4:e4b',
      providerId: 'ollama',
      remote: false,
    })
  })

  it('chatId and workspace cross copies the same way', async () => {
    const copyA = await freshCopy()
    copyA.setActiveChatId('my-chat-abc123')
    copyA.setActiveWorkspace({ kind: 'folder', path: 'C:/repo', extraPaths: ['C:/other'] })

    const copyB = await freshCopy()
    expect(copyB.getActiveChatId()).toBe('my-chat-abc123')
    expect(copyB.getActiveWorkspace()).toEqual({
      kind: 'folder',
      path: 'C:/repo',
      extraPaths: ['C:/other'],
    })
  })

  it('clearActiveChatId in one copy clears for all copies', async () => {
    const copyA = await freshCopy()
    copyA.setActiveChatId('chat-1')
    copyA.setActiveAgentModel({ name: 'qwen/qwen2.5-vl-7b', providerId: 'openai', remote: false })

    const copyB = await freshCopy()
    copyB.clearActiveChatId()

    expect(copyA.getActiveChatId()).toBeNull()
    expect(copyA.getActiveAgentModel()).toBeNull()
    expect(copyA.getActiveWorkspace()).toBeNull()
  })

  it('plain set/get round-trip still works within one copy', async () => {
    const ctx = await freshCopy()
    expect(ctx.getActiveAgentModel()).toBeNull()
    ctx.setActiveAgentModel({ name: 'x', providerId: 'ollama', remote: true })
    expect(ctx.getActiveAgentModel()).toEqual({ name: 'x', providerId: 'ollama', remote: true })
    ctx.setActiveAgentModel(null)
    expect(ctx.getActiveAgentModel()).toBeNull()
  })
})
