/**
 * Model-Picker store (v2.5.3) — promise rendezvous between the tool
 * executor (request) and the picker UI (choose/cancel), with a headless
 * auto-continue timeout and serialized overlapping requests.
 *
 * Run: npx vitest run src/stores/__tests__/modelPickStore.test.ts
 */
import { describe, it, expect, vi, afterEach } from 'vitest'
import { useModelPickStore, MODEL_PICK_TIMEOUT_MS } from '../modelPickStore'

afterEach(() => {
  // Never leak a pending pick (or its timeout) into the next test.
  if (useModelPickStore.getState().pending) useModelPickStore.getState().cancel()
  vi.useRealTimers()
})

describe('modelPickStore', () => {
  it('request exposes pending with kind/models/current', async () => {
    const p = useModelPickStore.getState().request('image', ['a.safetensors', 'b.safetensors'], 'a.safetensors')
    const pending = useModelPickStore.getState().pending
    expect(pending).toBeTruthy()
    expect(pending!.kind).toBe('image')
    expect(pending!.models).toEqual(['a.safetensors', 'b.safetensors'])
    expect(pending!.current).toBe('a.safetensors')
    useModelPickStore.getState().choose({ model: 'b.safetensors', save: false })
    expect(await p).toEqual({ model: 'b.safetensors', save: false })
  })

  it('choose resolves the promise and clears pending', async () => {
    const p = useModelPickStore.getState().request('video-t2v', ['wan.safetensors'], 'wan.safetensors')
    useModelPickStore.getState().choose({ model: 'wan.safetensors', save: true })
    expect(await p).toEqual({ model: 'wan.safetensors', save: true })
    expect(useModelPickStore.getState().pending).toBeNull()
  })

  it('cancel resolves null (caller falls back to the pre-selection)', async () => {
    const p = useModelPickStore.getState().request('video-i2v', ['svd.safetensors'], 'svd.safetensors')
    useModelPickStore.getState().cancel()
    expect(await p).toBeNull()
    expect(useModelPickStore.getState().pending).toBeNull()
  })

  it('choose/cancel without a pending request are no-ops', () => {
    expect(() => {
      useModelPickStore.getState().choose({ model: 'x', save: false })
      useModelPickStore.getState().cancel()
    }).not.toThrow()
  })

  it('a second request waits until the first resolves (serialized)', async () => {
    const first = useModelPickStore.getState().request('image', ['a'], 'a')
    let secondPendingSeen = false
    const second = useModelPickStore.getState().request('image', ['b'], 'b').then((c) => {
      secondPendingSeen = useModelPickStore.getState().pending === null
      return c
    })
    // While the first is pending, the second has NOT replaced it.
    expect(useModelPickStore.getState().pending!.models).toEqual(['a'])
    useModelPickStore.getState().choose({ model: 'a', save: false })
    expect(await first).toEqual({ model: 'a', save: false })
    // Now the second surfaces.
    await vi.waitFor(() => {
      if (useModelPickStore.getState().pending?.models[0] !== 'b') throw new Error('second not pending yet')
    })
    useModelPickStore.getState().choose({ model: 'b', save: false })
    expect(await second).toEqual({ model: 'b', save: false })
    expect(secondPendingSeen).toBe(true)
  })

  it('headless timeout auto-resolves null after MODEL_PICK_TIMEOUT_MS', async () => {
    vi.useFakeTimers()
    const p = useModelPickStore.getState().request('image', ['a'], 'a')
    expect(useModelPickStore.getState().pending).toBeTruthy()
    await vi.advanceTimersByTimeAsync(MODEL_PICK_TIMEOUT_MS + 1000)
    expect(await p).toBeNull()
    expect(useModelPickStore.getState().pending).toBeNull()
  })
})
