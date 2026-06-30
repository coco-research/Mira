import { describe, it, expect, vi, beforeEach } from 'vitest'

const mockInvoke = vi.fn(async () => undefined)
vi.mock('@tauri-apps/api/core', () => ({ invoke: mockInvoke }))
vi.mock('../../api/backend', () => ({
  isTauri: vi.fn(() => true),
}))
vi.mock('../../api/ollama', () => ({
  unloadModel: vi.fn(async () => undefined),
}))

import { useModelStore } from '../modelStore'

describe('useModelStore.dismissPull (Bug #5)', () => {
  beforeEach(() => {
    mockInvoke.mockClear()
    useModelStore.setState({ activePulls: {} })
  })

  it('aborts the AbortController so the live stream stops', () => {
    const controller = new AbortController()
    useModelStore.getState().startPull('llama3.1:8b', controller)

    useModelStore.getState().dismissPull('llama3.1:8b')

    expect(controller.signal.aborted).toBe(true)
  })

  it('invokes cancel_model_pull on the Rust side', async () => {
    const controller = new AbortController()
    useModelStore.getState().startPull('qwen2.5:14b', controller)

    useModelStore.getState().dismissPull('qwen2.5:14b')
    // The invoke is fired inside a dynamic import promise — flush it.
    await new Promise(r => setTimeout(r, 0))
    await new Promise(r => setTimeout(r, 0))

    expect(mockInvoke).toHaveBeenCalledWith('cancel_model_pull', { name: 'qwen2.5:14b' })
  })

  it('removes the entry from activePulls synchronously', () => {
    const controller = new AbortController()
    useModelStore.getState().startPull('mistral:7b', controller)
    expect(useModelStore.getState().activePulls['mistral:7b']).toBeDefined()

    useModelStore.getState().dismissPull('mistral:7b')

    expect(useModelStore.getState().activePulls['mistral:7b']).toBeUndefined()
  })

  it('is a no-op when there is no matching pull (idempotent)', () => {
    expect(() => useModelStore.getState().dismissPull('nonexistent:1b')).not.toThrow()
    expect(useModelStore.getState().activePulls['nonexistent:1b']).toBeUndefined()
  })

  it('protects against re-creation when a late progress event fires after dismiss', () => {
    const controller = new AbortController()
    useModelStore.getState().startPull('codellama:7b', controller)
    useModelStore.getState().dismissPull('codellama:7b')

    // Simulate a late `pull-progress` event arriving from Rust before the
    // listener has actually unsubscribed (the original repro).
    useModelStore.getState().updatePullProgress('codellama:7b', { status: 'late event' })

    expect(useModelStore.getState().activePulls['codellama:7b']).toBeUndefined()
  })
})
