import { useState, useEffect } from 'react'
import { useModelStore } from '../stores/modelStore'
import { useSettingsStore } from '../stores/settingsStore'
import { getProviderIdFromModel, displayModelName } from '../api/providers'
import { getModelContextCached } from '../api/ollama'
import { getLmStudioModelContext } from '../api/lmstudio'
import { getModelMaxTokens } from '../lib/context-compaction'
import { effectiveContextWindow } from '../lib/context-window'

export type CtxProvider = 'ollama' | 'lmstudio' | 'cloud' | 'unknown'

export interface ActiveContext {
  /** Which backend the active model runs on. */
  provider: CtxProvider
  /** The context window the model is ACTUALLY using right now — the TRUE
   *  denominator for the token counter. */
  contextWindow: number
  /** The model's ceiling, used to cap the dropdown presets (0 = unknown). */
  modelMax: number
  /** True when the value is the model's real, confirmed live context (Ollama
   *  num_ctx, or LM Studio's loaded_context_length) rather than a fallback. */
  isTrue: boolean
  /** Whether the user can change it from the dropdown (local backends only). */
  adjustable: boolean
}

/**
 * Resolve the REAL context window of the active model, provider-aware, so the
 * TokenCounter denominator and the Context dropdown agree and never lie:
 *   - Ollama:    num_ctx we send = effectiveContextWindow(realCtx, override).
 *   - LM Studio: loaded_context_length from the enhanced REST API — the value
 *                the model is genuinely running with (NOT its theoretical max).
 *   - Cloud:     the model's fixed max (can't be changed; not adjustable).
 *
 * `reloadTick` lets the dropdown force a re-read right after it reloads a model.
 */
export function useActiveContextWindow(reloadTick = 0): ActiveContext {
  const activeModel = useModelStore((s) => s.activeModel)
  const override = useSettingsStore((s) => s.settings.contextWindowOverride)
  const [state, setState] = useState<ActiveContext>({
    provider: 'unknown', contextWindow: 0, modelMax: 0, isTrue: false, adjustable: false,
  })

  // Re-read whenever a model reload finishes anywhere (the Context dropdown
  // fires this), so every consumer — counter AND dropdown — reflects the new
  // loaded context at the same time instead of drifting.
  const [reloadBump, setReloadBump] = useState(0)
  useEffect(() => {
    const onReloaded = () => setReloadBump((b) => b + 1)
    window.addEventListener('lu-context-reloaded', onReloaded)
    return () => window.removeEventListener('lu-context-reloaded', onReloaded)
  }, [])

  useEffect(() => {
    if (!activeModel) {
      setState({ provider: 'unknown', contextWindow: 0, modelMax: 0, isTrue: false, adjustable: false })
      return
    }
    let cancelled = false
    const providerId = getProviderIdFromModel(activeModel)

    ;(async () => {
      // ── Ollama: num_ctx is per-request, so what we send == what runs. ──
      if (providerId === 'ollama') {
        const max = await getModelContextCached(activeModel).catch(() => 0)
        if (cancelled) return
        setState({
          provider: 'ollama',
          contextWindow: effectiveContextWindow(max, override),
          modelMax: max,
          isTrue: true,
          adjustable: true,
        })
        return
      }

      // ── openai-compat: probe LM Studio's enhanced API. A real loaded/max
      //    value means it IS LM Studio; null means a cloud/other openai server. ──
      if (providerId === 'openai') {
        const modelId = displayModelName(activeModel)
        const info = await getLmStudioModelContext(modelId)
        if (cancelled) return
        if (info.loaded || info.max) {
          const loaded = info.loaded ?? 0
          const max = info.max ?? loaded
          setState({
            provider: 'lmstudio',
            contextWindow: loaded > 0
              ? loaded                                   // TRUE: what LM Studio actually loaded
              : (override > 0 ? override : Math.min(max || 8192, 16384)),
            modelMax: max,
            isTrue: loaded > 0,
            adjustable: true,
          })
          return
        }
      }

      // ── Cloud / other: fixed context, not adjustable from here. ──
      const max = await getModelMaxTokens(activeModel).catch(() => 4096)
      if (cancelled) return
      setState({
        provider: 'cloud',
        contextWindow: effectiveContextWindow(max, override),
        modelMax: max,
        isTrue: false,
        adjustable: false,
      })
    })()

    return () => { cancelled = true }
  }, [activeModel, override, reloadTick, reloadBump])

  return state
}
