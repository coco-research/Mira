import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import { version as currentVersion } from '../../package.json'
import { isTauri, backendCall } from '../api/backend'
import type { Update } from '@tauri-apps/plugin-updater'

// ── Types ─────────────────────────────────────────────────────

type DownloadStatus = 'idle' | 'downloading' | 'downloaded' | 'installing' | 'error'

interface UpdateState {
  currentVersion: string
  latestVersion: string | null
  updateAvailable: boolean
  releaseNotes: string | null
  isChecking: boolean
  lastChecked: number | null
  dismissed: string | null

  downloadStatus: DownloadStatus
  downloadProgress: number
  downloadedBytes: number
  totalBytes: number
  errorMessage: string | null

  checkForUpdate: () => Promise<void>
  downloadUpdate: () => Promise<void>
  installAndRestart: () => Promise<void>
  dismissUpdate: () => void
  clearDismiss: () => void
}

// ── Config ────────────────────────────────────────────────────

const GITHUB_REPO = 'purpledoubled/locally-uncensored'
const CHECK_INTERVAL = 6 * 60 * 60 * 1000 // 6 hours
const INITIAL_DELAY = 5_000

// ── Non-serializable update object (module-level) ─────────────

let _pendingUpdate: Update | null = null

// ── Semver compare (kept for dev mode fallback) ───────────────

export function isNewerVersion(latest: string, current: string): boolean {
  const parse = (v: string) => v.replace(/^v/, '').split('.').map(Number)
  const [lMajor, lMinor = 0, lPatch = 0] = parse(latest)
  const [cMajor, cMinor = 0, cPatch = 0] = parse(current)

  if (lMajor !== cMajor) return lMajor > cMajor
  if (lMinor !== cMinor) return lMinor > cMinor
  return lPatch > cPatch
}

// ── Store ─────────────────────────────────────────────────────

export const useUpdateStore = create<UpdateState>()(
  persist(
    (set, get) => ({
      currentVersion,
      latestVersion: null,
      updateAvailable: false,
      releaseNotes: null,
      isChecking: false,
      lastChecked: null,
      dismissed: null,

      downloadStatus: 'idle',
      downloadProgress: 0,
      downloadedBytes: 0,
      totalBytes: 0,
      errorMessage: null,

      checkForUpdate: async () => {
        const state = get()
        if (state.isChecking) return
        if (state.lastChecked && Date.now() - state.lastChecked < CHECK_INTERVAL) return

        set({ isChecking: true })

        try {
          if (isTauri()) {
            // Production: use Tauri updater plugin
            const { check } = await import('@tauri-apps/plugin-updater')
            const update = await check()

            if (update) {
              _pendingUpdate = update
              set({
                updateAvailable: true,
                latestVersion: update.version,
                releaseNotes: update.body ? truncateNotes(update.body) : null,
                isChecking: false,
                lastChecked: Date.now(),
                // Reset download state for new version
                downloadStatus: 'idle',
                downloadProgress: 0,
                downloadedBytes: 0,
                totalBytes: 0,
                errorMessage: null,
              })
            } else {
              set({ isChecking: false, lastChecked: Date.now(), updateAvailable: false })
            }
          } else {
            // Dev mode: check GitHub releases API (no install capability)
            const res = await fetch(
              `https://api.github.com/repos/${GITHUB_REPO}/releases/latest`,
              { headers: { 'Accept': 'application/vnd.github.v3+json' } }
            )
            if (!res.ok) {
              set({ isChecking: false, lastChecked: Date.now() })
              return
            }
            const data = await res.json()
            const latestVersion = (data.tag_name as string).replace(/^v/, '')
            const updateAvailable = isNewerVersion(latestVersion, currentVersion)

            set({
              latestVersion,
              updateAvailable,
              releaseNotes: data.body ? truncateNotes(data.body) : null,
              isChecking: false,
              lastChecked: Date.now(),
            })
          }
        } catch {
          set({ isChecking: false, lastChecked: Date.now() })
        }
      },

      downloadUpdate: async () => {
        if (!_pendingUpdate) return

        set({ downloadStatus: 'downloading', downloadProgress: 0, downloadedBytes: 0, errorMessage: null })
        let downloaded = 0

        try {
          await _pendingUpdate.download((event) => {
            switch (event.event) {
              case 'Started':
                set({ totalBytes: event.data.contentLength ?? 0 })
                break
              case 'Progress': {
                downloaded += event.data.chunkLength
                const total = get().totalBytes
                const progress = total > 0 ? Math.round((downloaded / total) * 100) : 0
                set({ downloadedBytes: downloaded, downloadProgress: progress })
                break
              }
              case 'Finished':
                set({ downloadStatus: 'downloaded', downloadProgress: 100 })
                break
            }
          })
        } catch (e) {
          set({
            downloadStatus: 'error',
            errorMessage: e instanceof Error ? e.message : 'Download failed',
          })
        }
      },

      installAndRestart: async () => {
        if (!_pendingUpdate) return

        set({ downloadStatus: 'installing' })

        try {
          await _pendingUpdate.install()
          // Exit so NSIS installer can overwrite the binary
          await backendCall('exit_app')
        } catch (e) {
          set({
            downloadStatus: 'error',
            errorMessage: e instanceof Error ? e.message : 'Install failed',
          })
        }
      },

      dismissUpdate: () => {
        const { latestVersion } = get()
        set({ dismissed: latestVersion })
      },

      clearDismiss: () => {
        set({ dismissed: null })
      },
    }),
    {
      name: 'lu-update-checker-v2',
      partialize: (state) => ({
        lastChecked: state.lastChecked,
        latestVersion: state.latestVersion,
        updateAvailable: state.updateAvailable,
        releaseNotes: state.releaseNotes,
        downloadStatus: state.downloadStatus,
      }),
      // Reset stale persisted state when the binary has been updated out-of-band
      // (e.g. user manually installed a newer .deb / .exe than what the persisted
      // "latest" snapshot remembers). Without this, the Updates tab can show
      // `Current: 2.4.1 | Latest: 2.3.8` indefinitely because checkForUpdate has
      // a 6h cooldown and a stale `latestVersion` survives in localStorage.
      onRehydrateStorage: () => (state) => {
        if (!state) return
        if (state.latestVersion && !isNewerVersion(state.latestVersion, currentVersion)) {
          state.latestVersion = null
          state.updateAvailable = false
          state.releaseNotes = null
          state.lastChecked = null
        }
      },
    }
  )
)

// ── Helpers ───────────────────────────────────────────────────

function truncateNotes(notes: string): string {
  const lines = notes.split('\n').filter(l => l.trim()).slice(0, 5)
  const text = lines.join('\n')
  return text.length > 300 ? text.substring(0, 300) + '...' : text
}

// ── Auto-check on app start ───────────────────────────────────

let _initDone = false
export function initUpdateChecker() {
  if (_initDone) return
  _initDone = true

  setTimeout(() => {
    useUpdateStore.getState().checkForUpdate()
  }, INITIAL_DELAY)

  setInterval(() => {
    useUpdateStore.getState().checkForUpdate()
  }, CHECK_INTERVAL)
}
