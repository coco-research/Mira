import { useState } from 'react'
import { RefreshCw, X, AlertTriangle, Check } from 'lucide-react'
import { useModelHealthStore } from '../../stores/modelHealthStore'
import { useModels } from '../../hooks/useModels'
import { checkModelCapability } from '../../api/ollama'

/**
 * Top-of-app banner shown when the startup health scan finds installed
 * Ollama models whose manifests are rejected by 0.20.7. Auto-hides when
 * all models are refreshed or the user dismisses for this session.
 *
 * Cause: Ollama auto-upgraded 0.20.6 → 0.20.7 today and started strict-
 * rejecting manifests pulled before the registry-side capabilities refresh.
 * Fix: re-pull each stale model. The banner does this serially via the
 * existing useModels.pullModel flow (progress lands in DownloadBadge).
 */
export function StaleModelsBanner() {
  const { staleModels, dismissed, dismiss, markFresh } = useModelHealthStore()
  const { pullModel, isPullingModel } = useModels()
  const [refreshingAll, setRefreshingAll] = useState(false)

  if (dismissed || staleModels.length === 0) return null

  const pending = staleModels.filter((m) => !isPullingModel(m))
  const inProgressCount = staleModels.filter((m) => isPullingModel(m)).length

  const refreshAll = async () => {
    if (refreshingAll) return
    setRefreshingAll(true)
    try {
      // Serial — one pull at a time keeps disk/network manageable and gives
      // clear progress in DownloadBadge without interleaved output.
      for (const name of pending) {
        try {
          await pullModel(name)
          // Verify post-pull: Ollama's on-disk manifest is refreshed, probe
          // to confirm 0.20.7 now accepts it before marking fresh.
          const check = await checkModelCapability(name)
          if (check.ok) markFresh(name)
        } catch {
          // Continue with next model; user can retry via the banner later.
        }
      }
    } finally {
      setRefreshingAll(false)
    }
  }

  return (
    <div
      className="flex items-center gap-3 px-3 py-1.5 border-b border-amber-400/30 bg-amber-500/10 backdrop-blur-sm"
      role="alert"
    >
      <AlertTriangle
        size={13}
        className="text-amber-600 dark:text-amber-400 shrink-0"
        aria-hidden="true"
      />
      <div className="flex-1 min-w-0 text-[0.7rem]">
        <span className="font-semibold text-amber-800 dark:text-amber-200">
          Ollama 0.20.7 broke {staleModels.length} of your model{staleModels.length === 1 ? '' : 's'}.
        </span>
        <span
          className="ml-1.5 text-amber-700/90 dark:text-amber-300/80 truncate inline-block max-w-[50vw] align-bottom"
          title={staleModels.join(', ')}
        >
          {staleModels.slice(0, 3).join(', ')}
          {staleModels.length > 3 ? `, +${staleModels.length - 3} more` : ''}
        </span>
        {inProgressCount > 0 && (
          <span className="ml-2 text-amber-600 dark:text-amber-300 text-[0.65rem]">
            · refreshing {inProgressCount}/{staleModels.length}
          </span>
        )}
      </div>
      <button
        onClick={refreshAll}
        disabled={refreshingAll || pending.length === 0}
        className="flex items-center gap-1 px-2 py-1 rounded bg-amber-500/20 border border-amber-400/40 text-amber-800 dark:text-amber-200 text-[0.65rem] font-medium hover:bg-amber-500/30 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
        title={`Re-pull ${staleModels.length} stale model${staleModels.length === 1 ? '' : 's'}`}
      >
        {refreshingAll ? (
          <>
            <RefreshCw size={10} className="animate-spin" />
            <span>Refreshing…</span>
          </>
        ) : pending.length === 0 ? (
          <>
            <Check size={10} />
            <span>Queued</span>
          </>
        ) : (
          <>
            <RefreshCw size={10} />
            <span>Refresh all</span>
          </>
        )}
      </button>
      <button
        onClick={dismiss}
        className="p-1 rounded text-amber-700/70 dark:text-amber-300/70 hover:text-amber-900 dark:hover:text-amber-100 hover:bg-amber-500/20 transition-colors"
        aria-label="Dismiss until next launch"
        title="Dismiss until next launch"
      >
        <X size={11} />
      </button>
    </div>
  )
}
