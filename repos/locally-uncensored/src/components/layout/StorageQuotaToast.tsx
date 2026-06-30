import { useEffect, useState } from 'react'
import { AlertTriangle, X } from 'lucide-react'

/**
 * §20 — One-time, non-spammy banner shown when a localStorage write was
 * dropped because the browser's storage quota is full (after conversation +
 * memory pruning already failed to make room). Listens for the
 * `lu:storage-quota-exceeded` CustomEvent that createSafeStorage dispatches.
 *
 * Debounced so a burst of failing writes (zustand persists fire on every
 * mutation) surfaces a single toast, not one per write. Stays mounted at the
 * top of AppShell — zero cost until the event fires, since it renders null
 * until then. The user dismisses it manually; we don't auto-hide because a
 * full disk is a sticky condition they should act on.
 */
export function StorageQuotaToast() {
  const [visible, setVisible] = useState(false)

  useEffect(() => {
    // Debounce: collapse a flurry of quota events into one visible toast.
    let timer: ReturnType<typeof setTimeout> | null = null
    const onQuota = () => {
      if (timer) return
      timer = setTimeout(() => {
        setVisible(true)
        timer = null
      }, 300)
    }
    window.addEventListener('lu:storage-quota-exceeded', onQuota as EventListener)
    return () => {
      window.removeEventListener('lu:storage-quota-exceeded', onQuota as EventListener)
      if (timer) clearTimeout(timer)
    }
  }, [])

  if (!visible) return null

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
          App storage limit reached — that setting wasn't saved.
        </span>
        <span className="ml-1.5 text-amber-700/90 dark:text-amber-300/80">
          This is the browser's small per-app store, not your disk space. Your chats and
          memories live in a separate, much larger local database and are unaffected.
        </span>
      </div>
      <button
        onClick={() => setVisible(false)}
        className="p-1 rounded text-amber-700/70 dark:text-amber-300/70 hover:text-amber-900 dark:hover:text-amber-100 hover:bg-amber-500/20 transition-colors"
        aria-label="Dismiss"
        title="Dismiss"
      >
        <X size={11} />
      </button>
    </div>
  )
}
