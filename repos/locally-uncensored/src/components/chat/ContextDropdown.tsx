import { useState } from 'react'
import { ChevronDown, Check, Loader2 } from 'lucide-react'
import { useModelStore } from '../../stores/modelStore'
import { useSettingsStore } from '../../stores/settingsStore'
import { getProviderIdFromModel, displayModelName } from '../../api/providers'
import { getModelContextCached, warmupOllamaContext } from '../../api/ollama'
import { loadLmStudioModel } from '../../api/lmstudio'
import { effectiveContextWindow } from '../../lib/context-window'
import { useActiveContextWindow } from '../../hooks/useActiveContextWindow'

const PRESETS = [4096, 8192, 16384, 32768, 65536, 131072]

const fmt = (n: number) =>
  n <= 0 ? 'Auto'
    : n % 1024 === 0 ? `${n / 1024}K`
      : n >= 1000 ? `${Math.round(n / 1000)}K`
        : String(n)

/**
 * Context-window picker for the active LOCAL model. Sets `contextWindowOverride`
 * and AUTO-RELOADS the model so the change takes effect immediately:
 *   - Ollama:    warm the model with the new num_ctx (Ollama reloads its runner).
 *   - LM Studio: `lms load -c <N>` (unload + reload — context is load-time there).
 * Hidden for cloud models (their context is fixed and not adjustable here).
 */
export function ContextDropdown() {
  const activeModel = useModelStore((s) => s.activeModel)
  const override = useSettingsStore((s) => s.settings.contextWindowOverride)
  const updateSettings = useSettingsStore((s) => s.updateSettings)
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const [tick, setTick] = useState(0)
  const ctx = useActiveContextWindow(tick)

  if (!activeModel || !ctx.adjustable) return null

  const max = ctx.modelMax > 0 ? ctx.modelMax : 131072
  const options = PRESETS.filter((p) => p <= Math.max(max, 4096))
  const showMax = ctx.modelMax > 0 && !options.includes(ctx.modelMax) && ctx.modelMax > (options[options.length - 1] || 0)

  const apply = async (value: number) => {
    setOpen(false)
    if (value === override) return
    setBusy(true)
    updateSettings({ contextWindowOverride: value }) // 0 = Auto
    try {
      const providerId = getProviderIdFromModel(activeModel)
      if (providerId === 'ollama') {
        const target = value > 0
          ? value
          : effectiveContextWindow(await getModelContextCached(activeModel).catch(() => 0), 0)
        await warmupOllamaContext(activeModel, target)
      } else if (ctx.provider === 'lmstudio') {
        // value 0 (Auto) -> reload without -c so LM Studio picks its default.
        await loadLmStudioModel(displayModelName(activeModel), value > 0 ? value : undefined)
      }
    } catch {
      /* non-fatal — the counter will simply keep its prior value */
    } finally {
      setBusy(false)
      setTick((t) => t + 1) // re-read the model's real loaded context
      // Tell the token counter (and any other consumer) to re-read too.
      window.dispatchEvent(new Event('lu-context-reloaded'))
    }
  }

  const rowCls = (selected: boolean) =>
    `flex items-center justify-between gap-3 text-left px-2 py-1 rounded-md text-[0.6rem] transition-colors ${
      selected
        ? 'bg-gray-100 dark:bg-white/[0.08] text-gray-900 dark:text-white font-medium'
        : 'text-gray-500 hover:bg-gray-50 dark:hover:bg-white/[0.04] hover:text-gray-700 dark:hover:text-gray-200'
    }`

  return (
    <div className="relative">
      <button
        onClick={() => setOpen((o) => !o)}
        disabled={busy}
        title={`Context window — ${ctx.provider === 'lmstudio' ? "LM Studio's loaded context" : 'Ollama num_ctx'}. Changing it reloads the model so it takes effect now.`}
        className="flex items-center gap-1 px-1.5 py-0.5 rounded border border-gray-200 dark:border-white/[0.06] hover:border-gray-400 dark:hover:border-white/15 text-gray-500 transition-colors text-[0.55rem] font-mono tabular-nums disabled:opacity-60"
      >
        {busy ? <Loader2 size={9} className="animate-spin" /> : null}
        <span>ctx {fmt(ctx.contextWindow)}</span>
        <ChevronDown size={8} className={`transition-transform ${open ? 'rotate-180' : ''}`} />
      </button>
      {open && (
        <>
          <div className="fixed inset-0 z-40" onClick={() => setOpen(false)} />
          <div className="absolute right-0 top-full mt-1 z-50 min-w-[140px] rounded-lg bg-white dark:bg-[#1a1a1a] border border-gray-200 dark:border-white/10 shadow-xl p-1 flex flex-col gap-0.5">
            <button onClick={() => apply(0)} className={rowCls(override === 0)}>
              <span>Auto{ctx.provider === 'ollama' ? ` · ${fmt(effectiveContextWindow(ctx.modelMax, 0))}` : ''}</span>
              {override === 0 && <Check size={10} />}
            </button>
            {options.map((p) => (
              <button key={p} onClick={() => apply(p)} className={rowCls(override === p)}>
                <span>{fmt(p)}</span>
                {override === p && <Check size={10} />}
              </button>
            ))}
            {showMax && (
              <button onClick={() => apply(ctx.modelMax)} className={rowCls(override === ctx.modelMax)}>
                <span>{fmt(ctx.modelMax)} · max</span>
                {override === ctx.modelMax && <Check size={10} />}
              </button>
            )}
            <div className="mt-0.5 px-2 pt-1 border-t border-gray-100 dark:border-white/[0.06] text-[0.5rem] text-gray-400 leading-snug">
              Reloads the model on change.
            </div>
          </div>
        </>
      )}
    </div>
  )
}
