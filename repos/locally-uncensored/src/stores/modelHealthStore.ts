import { create } from 'zustand'
import { persist } from 'zustand/middleware'

/**
 * Tracks which installed Ollama models have stale manifests (rejected by
 * Ollama 0.20.7 with "does not support (chat|completion|generate)").
 *
 * Populated by the startup health scan (AppShell) and consumed by:
 *   - StaleModelsBanner — top-of-app notice with "Refresh All"
 *   - Header Lichtschalter — knows without a load attempt that the model is stale
 *   - DiscoverModels — shows "Needs Refresh" badge instead of green "Installed"
 *
 * `dismissed` is session-only so the banner reappears next launch if stale
 * models remain. `lastScanTime` is persisted so we can skip re-scan for a
 * cool-down window on app restart.
 */

interface ModelHealthState {
  staleModels: string[]
  lastScanTime: number
  scanning: boolean
  dismissed: boolean
  // actions
  setStaleModels: (models: string[]) => void
  markFresh: (name: string) => void
  setScanning: (scanning: boolean) => void
  dismiss: () => void
  reset: () => void
}

export const useModelHealthStore = create<ModelHealthState>()(
  persist(
    (set) => ({
      staleModels: [],
      lastScanTime: 0,
      scanning: false,
      dismissed: false,
      setStaleModels: (models) =>
        set({ staleModels: models, lastScanTime: Date.now(), dismissed: false }),
      markFresh: (name) =>
        set((s) => ({ staleModels: s.staleModels.filter((m) => m !== name) })),
      setScanning: (scanning) => set({ scanning }),
      dismiss: () => set({ dismissed: true }),
      reset: () =>
        set({ staleModels: [], scanning: false, dismissed: false, lastScanTime: 0 }),
    }),
    {
      name: 'locally-uncensored-model-health',
      // Only persist the scan result + timestamp. `scanning` and `dismissed`
      // are intentionally session-only.
      partialize: (s) => ({ staleModels: s.staleModels, lastScanTime: s.lastScanTime }),
    }
  )
)
