import { describe, it, expect, beforeEach } from 'vitest'
import { useCloudTeaserStore } from '../cloudTeaserStore'

// ═══════════════════════════════════════════════════════════════
//  cloudTeaserStore — Cloud waitlist teaser persistence
// ═══════════════════════════════════════════════════════════════

describe('cloudTeaserStore', () => {
  beforeEach(() => {
    useCloudTeaserStore.setState({ dismissed: false, submitted: false })
  })

  it('defaults to visible and not-yet-submitted', () => {
    const s = useCloudTeaserStore.getState()
    expect(s.dismissed).toBe(false)
    expect(s.submitted).toBe(false)
  })

  it('setSubmitted flips the join flag without dismissing the badge', () => {
    useCloudTeaserStore.getState().setSubmitted(true)
    const s = useCloudTeaserStore.getState()
    expect(s.submitted).toBe(true)
    // Per the plan: joining the list must NOT hide the badge.
    expect(s.dismissed).toBe(false)
  })

  it('setDismissed is the only thing that hides the badge', () => {
    useCloudTeaserStore.getState().setDismissed(true)
    expect(useCloudTeaserStore.getState().dismissed).toBe(true)
  })
})
