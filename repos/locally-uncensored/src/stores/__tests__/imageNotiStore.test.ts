import { describe, it, expect, beforeEach } from 'vitest'
import { useImageNotiStore } from '../imageNotiStore'

// ═══════════════════════════════════════════════════════════════
//  imageNotiStore — image-tool discovery noti persistence
// ═══════════════════════════════════════════════════════════════

describe('imageNotiStore', () => {
  beforeEach(() => {
    useImageNotiStore.setState({ seen: false, eligible: null })
  })

  it('defaults to unseen + eligibility-unknown', () => {
    const s = useImageNotiStore.getState()
    expect(s.seen).toBe(false)
    expect(s.eligible).toBe(null)
  })

  it('setSeen hides the noti for good', () => {
    useImageNotiStore.getState().setSeen(true)
    expect(useImageNotiStore.getState().seen).toBe(true)
  })

  it('setEligible records the hardware probe result', () => {
    useImageNotiStore.getState().setEligible(true)
    expect(useImageNotiStore.getState().eligible).toBe(true)
    useImageNotiStore.getState().setEligible(false)
    expect(useImageNotiStore.getState().eligible).toBe(false)
  })
})
