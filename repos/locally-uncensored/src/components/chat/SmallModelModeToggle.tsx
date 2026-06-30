import { Feather } from 'lucide-react'
import { useSettingsStore } from '../../stores/settingsStore'

/**
 * Small-Model Mode toggle (v2.5.0). A compact toolbar pill that flips
 * `settings.smallModelMode` — the evidence-backed lean profile that helps small
 * local models (3B-8B, e.g. gemma4:e4b, Llama-3.2-3B) reliably emit tool calls
 * and retain earlier steps. When on it: caps + embedding-ranks the tool list,
 * swaps in a lean system prompt, truncates long tool outputs, and compacts
 * history harder. It deliberately does NOT lower num_ctx (research: the
 * num_ctx-as-ceiling fear is largely a myth). Off by default — big models are
 * unaffected. Matches the ContextDropdown pill styling; lives in the Code and
 * (agent-active) Chat toolbars.
 */
export function SmallModelModeToggle() {
  const on = useSettingsStore((s) => s.settings.smallModelMode)
  const updateSettings = useSettingsStore((s) => s.updateSettings)

  return (
    <button
      onClick={() => updateSettings({ smallModelMode: !on })}
      title={
        on
          ? 'Small-Model Mode: ON — lean profile for small local models (3B-8B):\n• fewer tools (embedding-ranked + capped)\n• lean system prompt\n• truncated tool outputs\n• tighter history compaction\n(num_ctx is left untouched on purpose.)\nClick to turn off.'
          : 'Small-Model Mode — lean profile that helps small local models (3B-8B) emit valid tool calls and remember earlier steps. Click to turn on.'
      }
      className={
        'flex items-center gap-1 px-1.5 py-0.5 rounded border transition-colors text-[0.55rem] ' +
        (on
          ? 'border-violet-500/40 bg-violet-500/[0.08] text-violet-600 dark:text-violet-300'
          : 'border-gray-200 dark:border-white/[0.06] text-gray-500 hover:border-gray-400 dark:hover:border-white/15')
      }
    >
      <Feather size={9} className="shrink-0" />
      <span>Small-Model{on ? ' · on' : ''}</span>
    </button>
  )
}
