/**
 * Feature EE (v2.5.0) — React listener for VRAM hand-off phase events.
 *
 * Subscribes to the orchestrator's EventTarget channel (src/api/vram-handoff.ts
 * `onHandoff`) and maps the latest phase into component state for VramSwitchCard.
 *
 * Design note — the card is about the SWAP, not the generation. When the
 * orchestrator decides the models co-exist in VRAM (auto-fits / cloud / remote /
 * never), no `freeing_vram` phase ever fires — it goes deciding → generating →
 * done. In that case `swapping` stays false and the card hides itself, leaving
 * the normal ToolCallBlock spinner to convey "running". Only an ACTUAL eviction
 * (`freeing_vram` observed) flips `swapping` true and reveals the card. The
 * `done`/`error` terminal events reset it.
 */

import { useEffect, useState } from 'react'
import { onHandoff, type HandoffPhase } from '../api/vram-handoff'

export interface VramHandoffState {
  /** True only while an actual VRAM swap is in flight (eviction observed, not yet terminal). */
  swapping: boolean
  /** Latest phase seen. */
  phase: HandoffPhase | null
  /** 'image' | 'video' for copy tailoring. */
  kind: 'image' | 'video' | null
  /** Free-text detail (model name / error message). */
  detail: string | null
}

const INITIAL: VramHandoffState = { swapping: false, phase: null, kind: null, detail: null }

export function useVramHandoff(): VramHandoffState {
  const [state, setState] = useState<VramHandoffState>(INITIAL)

  useEffect(() => {
    const unsub = onHandoff((d) => {
      setState((prev) => {
        // A swap is "real" once we see freeing_vram; it ends on a terminal event.
        let swapping = prev.swapping
        if (d.phase === 'freeing_vram') swapping = true
        if (d.terminal) swapping = false
        return {
          swapping,
          phase: d.phase,
          kind: d.kind ?? prev.kind,
          detail: d.detail ?? null,
        }
      })
      // After a terminal event, fully reset shortly so a fresh generation starts
      // from a clean slate (and the card unmounts cleanly).
      if (d.terminal) {
        setTimeout(() => setState(INITIAL), 1200)
      }
    })
    return unsub
  }, [])

  return state
}
