/**
 * Feature EE (v2.5.0) — VRAM hand-off status card.
 *
 * Rendered inside the active assistant message while the image/video generation
 * orchestrator swaps the chat model out of VRAM and the ComfyUI model in. It
 * subscribes (via useVramHandoff) to the orchestrator's phase events and shows
 * HONEST per-phase copy — the point of the swap is OOM-avoidance + keeping the
 * conversation intact, NOT speed, so the copy says "~30-90s" plainly and never
 * implies a seamless zero-latency experience.
 *
 * Visibility: only shown when an ACTUAL swap is happening (the hook flips
 * `swapping` true on the first `freeing_vram` event). When the models fit
 * together (auto-decision, cloud, remote, or 'never' mode) no eviction occurs,
 * the card stays hidden, and the normal ToolCallBlock spinner conveys progress.
 */

import { motion, AnimatePresence } from 'framer-motion'
import { Loader2, Cpu, Check } from 'lucide-react'
import { useVramHandoff } from '../../hooks/useVramHandoff'
import type { HandoffPhase } from '../../api/vram-handoff'

function copyFor(phase: HandoffPhase | null, kind: 'image' | 'video' | null, detail: string | null): { text: string; sub?: string; done?: boolean } {
  const what = kind === 'video' ? 'video' : 'image'
  switch (phase) {
    case 'deciding':
      return { text: 'Checking VRAM…' }
    case 'freeing_vram':
      return {
        text: 'Freeing VRAM for the ' + what + ' model',
        sub: detail ? `unloading ${detail} (chat is preserved)` : 'unloading the chat model (chat is preserved)',
      }
    case 'loading_image_model':
      return { text: `Loading the ${what} model…`, sub: 'starting ComfyUI if needed — this can take a moment' }
    case 'generating':
      return { text: `Generating the ${what}…`, sub: 'VRAM swap in progress — usually 30-90s (longer on a cold start)' }
    case 'restoring_text':
      return { text: 'Restoring the chat model', sub: detail ? `reloading ${detail}` : 'reloading into VRAM' }
    case 'done':
      return { text: 'Chat model restored', done: true }
    case 'error':
      return { text: 'VRAM swap interrupted', sub: 'the chat model is being restored', done: true }
    default:
      return { text: 'Swapping models…' }
  }
}

export function VramSwitchCard() {
  const { swapping, phase, kind, detail } = useVramHandoff()

  // Only render during an actual swap. The `done`/`error` terminal frames flip
  // `swapping` false immediately, but we still want to flash a brief "restored"
  // confirmation, so we also render while the phase is a terminal one.
  const terminal = phase === 'done' || phase === 'error'
  const visible = swapping || terminal

  const { text, sub, done } = copyFor(phase, kind, detail)

  return (
    <AnimatePresence>
      {visible && (
        <motion.div
          initial={{ opacity: 0, y: 4 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: -4 }}
          transition={{ duration: 0.15 }}
          className="flex items-start gap-2 px-2.5 py-1.5 rounded-md border border-gray-200 dark:border-white/10 bg-gray-50 dark:bg-white/[0.05] text-[0.65rem] text-gray-700 dark:text-gray-200"
        >
          <span className="mt-0.5 shrink-0">
            {done ? <Check size={12} className="text-emerald-500" /> : <Loader2 size={12} className="animate-spin" />}
          </span>
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-1 font-medium">
              <Cpu size={10} className="opacity-70 shrink-0" />
              <span className="truncate">{text}</span>
            </div>
            {sub && <p className="opacity-75 mt-0.5 leading-snug">{sub}</p>}
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  )
}
