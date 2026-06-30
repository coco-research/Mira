import { describe, it, expect, beforeEach } from 'vitest'
import { useGenerationStore } from '../generationStore'

describe('generationStore — per-conversation generating flags', () => {
  beforeEach(() => {
    useGenerationStore.setState({ generating: {} })
  })

  it('starts empty', () => {
    expect(useGenerationStore.getState().generating).toEqual({})
  })

  it('marks a conversation generating and clears it', () => {
    const { setGenerating } = useGenerationStore.getState()
    setGenerating('chat-a', true)
    expect(useGenerationStore.getState().generating['chat-a']).toBe(true)
    setGenerating('chat-a', false)
    expect(useGenerationStore.getState().generating['chat-a']).toBeUndefined()
  })

  it('tracks two conversations independently — the bug fix', () => {
    const { setGenerating } = useGenerationStore.getState()
    // Generating in B must NOT mark A as generating (the typing-indicator bug).
    setGenerating('chat-b', true)
    expect(useGenerationStore.getState().generating['chat-b']).toBe(true)
    expect(useGenerationStore.getState().generating['chat-a']).toBeUndefined()
  })

  it('ignores a null/undefined conversation id', () => {
    const { setGenerating } = useGenerationStore.getState()
    setGenerating(null, true)
    setGenerating(undefined, true)
    expect(useGenerationStore.getState().generating).toEqual({})
  })

  it('is a no-op (same object reference) when the flag is already set', () => {
    const { setGenerating } = useGenerationStore.getState()
    setGenerating('chat-a', true)
    const ref1 = useGenerationStore.getState().generating
    setGenerating('chat-a', true) // already true → must not replace the map
    expect(useGenerationStore.getState().generating).toBe(ref1)
  })

  it('clearing an already-idle conversation is a no-op', () => {
    const { setGenerating } = useGenerationStore.getState()
    const ref1 = useGenerationStore.getState().generating
    setGenerating('never-started', false)
    expect(useGenerationStore.getState().generating).toBe(ref1)
  })
})
