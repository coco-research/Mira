import { useState, useEffect } from 'react'
import { Menu, Loader2, Sun, Moon, RefreshCw, X, MoreVertical } from 'lucide-react'
import { useUIStore } from '../../stores/uiStore'
import { useSettingsStore } from '../../stores/settingsStore'
import { useChatStore } from '../../stores/chatStore'
import { useCompareStore } from '../../stores/compareStore'
import { useModelStore } from '../../stores/modelStore'
import { ModelSelector } from '../models/ModelSelector'
import { MemoryDebugToggle } from '../chat/MemoryDebugPanel'
import { UpdateBadge } from './UpdateBadge'
import { DownloadBadge } from './DownloadBadge'
import { CloudWaitlistBadge } from './CloudWaitlistBadge'
import { CreateTopControls } from '../create/CreateTopControls'
import { loadModel } from '../../api/ollama'
import { getProviderIdFromModel } from '../../api/providers'
import { ModelLoadError } from '../../lib/ollama-errors'
import { useModels } from '../../hooks/useModels'
import { useModelHealthStore } from '../../stores/modelHealthStore'
import { checkModelCapability } from '../../api/ollama'

export function Header() {
  const { currentView, toggleSidebar, setView } = useUIStore()
  const { settings, updateSettings } = useSettingsStore()
  const isComparing = useCompareStore((s) => s.isComparing)
  const activeModel = useModelStore((s) => s.activeModel)
  const [loadingState, setLoadingState] = useState<'idle' | 'loading' | 'unloading'>('idle')
  // Stale-manifest notice shown next to the Lichtschalter when Ollama rejects
  // the model with "does not support (chat|completion|generate)". Offers a
  // one-click refresh that re-pulls the model (progress tracked in DownloadBadge).
  const [staleError, setStaleError] = useState<{ model: string; message: string } | null>(null)
  const { pullModel, isPullingModel } = useModels()
  const healthStaleModels = useModelHealthStore((s) => s.staleModels)
  const addStaleToHealth = useModelHealthStore((s) => s.setStaleModels)
  const markHealthFresh = useModelHealthStore((s) => s.markFresh)
  const [showMoreMenu, setShowMoreMenu] = useState(false)
  const isCreateView = currentView === 'create'

  // Check if active model is an Ollama model
  const isOllamaModel = activeModel ? getProviderIdFromModel(activeModel) === 'ollama' : false
  const modelToUse = activeModel?.includes('::') ? activeModel.split('::')[1] : activeModel
  const isRefreshing = modelToUse ? isPullingModel(modelToUse) : false

  // Merge a single stale discovery into the shared health store so the top
  // banner and any Model Manager indicators update in lock-step with the
  // inline Lichtschalter chip.
  const syncStaleToStore = (name: string) => {
    const current = useModelHealthStore.getState().staleModels
    if (!current.includes(name)) addStaleToHealth([...current, name])
  }

  const handleLoad = async () => {
    if (!modelToUse || loadingState !== 'idle') return
    setStaleError(null)
    setLoadingState('loading')
    try {
      await loadModel(modelToUse)
      // If the store still thinks this model is stale (e.g. a scan ran before
      // the user re-pulled externally), clear it.
      markHealthFresh(modelToUse)
    } catch (e) {
      // Bug C (v2.4.5 — Anson192 GH #39): missing-blob errors get the same
      // one-click repair path as stale-manifest — `ollama pull <name>`
      // re-fetches missing blobs just like it refreshes stale manifests.
      if (e instanceof ModelLoadError && (e.kind === 'stale-manifest' || e.kind === 'missing-blob')) {
        setStaleError({ model: e.model, message: e.message })
        syncStaleToStore(e.model)
      }
    }
    finally { setLoadingState('idle') }
  }

  const handleRefreshStale = async () => {
    if (!staleError) return
    const name = staleError.model
    // pullModel wires into the DownloadBadge via useModels' activePulls store —
    // user sees progress in the header badge. After the pull completes,
    // verify via a cheap probe and then re-attempt the load automatically.
    try {
      await pullModel(name)
      const check = await checkModelCapability(name)
      if (check.ok) {
        markHealthFresh(name)
        setStaleError(null)
        setTimeout(() => { handleLoad() }, 200)
      }
      // If still not ok, keep the chip visible so the user can retry.
    } catch {
      // error stays visible — user can click Refresh again
    }
  }

  // When the startup health scan flags this model as stale, pre-populate the
  // chip so the user sees it WITHOUT having to click the broken toggle first.
  // Also clear the chip when the user switches to a fresh model, OR when the
  // chip was pinned to a DIFFERENT model than the one currently selected
  // (otherwise the red Lichtschalter and chip from the old stale model
  // leak onto the new fresh model).
  useEffect(() => {
    if (!modelToUse || !isOllamaModel) {
      if (staleError) setStaleError(null)
      return
    }
    const isStale = healthStaleModels.includes(modelToUse)
    if (isStale && !staleError) {
      setStaleError({
        model: modelToUse,
        message: `Model "${modelToUse}" has a stale manifest. Run "ollama pull ${modelToUse}" to refresh.`,
      })
    } else if (!isStale && staleError) {
      // User switched to a fresh model — drop the stale chip from the previous one.
      setStaleError(null)
    } else if (staleError && staleError.model !== modelToUse) {
      // Stale chip was for a different model; re-pin to the current one (it's stale too).
      setStaleError({
        model: modelToUse,
        message: `Model "${modelToUse}" has a stale manifest. Run "ollama pull ${modelToUse}" to refresh.`,
      })
    }
  }, [modelToUse, isOllamaModel, healthStaleModels, staleError])

  const toggleTheme = () => {
    updateSettings({ theme: settings.theme === 'dark' ? 'light' : 'dark' })
  }

  const textNav = (view: string, label: string) => (
    <button
      onClick={() => {
        useCompareStore.getState().setComparing(false)
        setView(view as any)
      }}
      className={`text-[0.6rem] font-medium transition-colors ${currentView === view && !isComparing
        ? 'text-gray-900 dark:text-white'
        : 'text-gray-500 dark:text-gray-500 hover:text-gray-900 dark:hover:text-white'
        }`}
    >
      {label}
    </button>
  )

  const dropdownNav = (view: string, label: string) => (
    <button
      onClick={() => {
        useCompareStore.getState().setComparing(false)
        setView(view as any)
        setShowMoreMenu(false)
      }}
      className={`text-left text-[0.6rem] font-medium transition-colors ${currentView === view && !isComparing
        ? 'text-gray-900 dark:text-white'
        : 'text-gray-500 dark:text-gray-500 hover:text-gray-900 dark:hover:text-white'
        }`}
    >
      {label}
    </button>
  )

  useEffect(() => {
    if (!showMoreMenu) return

    const handlePointerDown = () => {
      setShowMoreMenu(false)
    }

    document.addEventListener('pointerdown', handlePointerDown)

    return () => {
      document.removeEventListener('pointerdown', handlePointerDown)
    }
  }, [showMoreMenu])

  return (
    <header className="h-10 grid grid-cols-[auto_1fr_auto] items-center px-3 bg-gray-100 dark:bg-[#141414] z-40 gap-4">
      {/* Left: Sidebar + Logo */}
      <div className="flex items-center gap-2 min-w-0">
        <button
          onClick={toggleSidebar}
          className="p-1 rounded-md hover:bg-gray-200 dark:hover:bg-white/5 text-gray-500 hover:text-gray-800 dark:hover:text-white transition-colors"
          aria-label="Toggle sidebar"
        >
          <Menu size={15} />
        </button>
        <button
          onClick={() => {
            useChatStore.getState().setActiveConversation(null)
            useCompareStore.getState().setComparing(false)
            setView('chat')
          }}
          className="flex items-center shrink-0 text-gray-600 dark:text-gray-300 hover:text-gray-900 dark:hover:text-white transition"
          aria-label="Locally Uncensored"
        >
          {/* Top-panel brand mark: the black/white monogram only (no wordmark),
              inverted per theme. Matches the web companion. */}
          <img src="/LU-monogram-bw.png" alt="" width={33} height={33} className="dark:invert-0 invert opacity-80" />
        </button>
        {/* Cloud "Hosted LU Workflows" waitlist teaser — subtle opt-in badge
            in the brand area (David 2026-06-06). Sends nothing unless the user
            explicitly joins; hidden for good only via "Don't show me again". */}
        <CloudWaitlistBadge />
      </div>

      {/* Center: model picker, geometrically centered between the logo (left)
          and the utilities (right). The per-row Lichtschalter that used to
          live here has moved INTO the dropdown — each model row in
          `ModelSelector` has its own load/unload toggle next to the name. */}
      <div className="lg:absolute lg:left-1/2 lg:-translate-x-1/2 flex items-center justify-center gap-2 min-w-0 ">
        {currentView === 'create' ? (
          <CreateTopControls />
        ) : (
          <>
            <ModelSelector />
            {/* Lichtschalter (load/unload into VRAM) now lives per-row inside the
            ModelSelector dropdown — the header center stays just the picker. */}
            {/* Memory — moved here from the chat/code/agent toolbars (David
            2026-06-06). One brain icon next to the model picker → editable
            memory popover (view / add / delete the injected context). */}
            <MemoryDebugToggle />

            {isOllamaModel && staleError && (
              <div
                className="ml-1.5 flex items-center gap-1 px-1.5 py-[2px] rounded-md bg-amber-500/10 border border-amber-400/30 text-[0.6rem]"
                title={staleError.message}
              >
                <span className="text-amber-600 dark:text-amber-300 font-medium">
                  stale — refresh?
                </span>
                <button
                  onClick={handleRefreshStale}
                  disabled={isRefreshing}
                  className="flex items-center gap-0.5 px-1 py-[1px] rounded text-amber-700 dark:text-amber-200 hover:bg-amber-500/20 disabled:opacity-50 transition-colors"
                  title={`Re-pull ${staleError.model}`}
                >
                  {isRefreshing ? (
                    <Loader2 size={9} className="animate-spin" />
                  ) : (
                    <RefreshCw size={9} />
                  )}
                  <span>Refresh</span>
                </button>
                <button
                  onClick={() => setStaleError(null)}
                  className="flex items-center p-[1px] rounded text-amber-600/70 hover:text-amber-800 hover:bg-amber-500/20 transition-colors"
                  title="Dismiss"
                  aria-label="Dismiss"
                >
                  <X size={9} />
                </button>
              </div>
            )}
          </>
        )}
      </div>

      {/* Right: text nav + icon utilities */}
      <div className="flex items-center justify-end gap-2.5 min-w-0">
        <DownloadBadge />

        <button
          onClick={toggleTheme}
          className="p-1 rounded-md text-gray-500 hover:text-gray-800 dark:hover:text-gray-200 hover:bg-gray-100 dark:hover:bg-white/5 transition-colors"
          title={settings.theme === 'dark' ? 'Light Mode' : 'Dark Mode'}
        >
          {settings.theme === 'dark' ? <Sun size={14} /> : <Moon size={14} />}
        </button>

        {/* Desktop navigation */}
        <div className={
          isCreateView
            ? "hidden xl:flex items-center gap-2.5"
            : "hidden lg:flex items-center gap-2.5"
        }>
          {textNav('chat', 'Chat')}
          {textNav('create', 'Create')}

          <button
            onClick={() => {
              useCompareStore.getState().setComparing(true)
              setView('chat')
            }}
            className={`text-[0.6rem] font-medium transition-colors ${isComparing
              ? 'text-gray-900 dark:text-white'
              : 'text-gray-500 dark:text-gray-500 hover:text-gray-900 dark:hover:text-white'
              }`}
          >
            Compare
          </button>

          {textNav('benchmark', 'Benchmark')}
          {textNav('models', 'Models')}
          {textNav('settings', 'Settings')}
        </div>

        {/* Collapsed navigation */}
        <div className={
          isCreateView
            ? "relative xl:hidden"
            : "relative lg:hidden"
        }>
          <button
            onClick={() => setShowMoreMenu(!showMoreMenu)}
            className="p-1 rounded-md text-gray-500 hover:text-gray-800 dark:hover:text-gray-200 hover:bg-gray-100 dark:hover:bg-white/5 transition-colors"
            title="More"
          >
            <MoreVertical size={16} />
          </button>

          {showMoreMenu && (
            <div onPointerDown={(e) => e.stopPropagation()} className="absolute right-0 top-full mt-2 w-40 rounded-lg border border-gray-200 dark:border-white/10 bg-white dark:bg-[#1a1a1a] shadow-xl z-50">
              <div className="flex flex-col gap-2 p-3">

                {dropdownNav('chat', 'Chat')}
                {dropdownNav('create', 'Create')}

                <button
                  onClick={() => {
                    useCompareStore.getState().setComparing(true)
                    setView('chat')
                    setShowMoreMenu(false)
                  }}
                  className={`text-left text-[0.6rem] font-medium transition-colors ${isComparing
                    ? 'text-gray-900 dark:text-white'
                    : 'text-gray-500 dark:text-gray-500 hover:text-gray-900 dark:hover:text-white'
                    }`}
                >
                  Compare
                </button>

                {dropdownNav('benchmark', 'Benchmark')}
                {dropdownNav('models', 'Models')}
                {dropdownNav('settings', 'Settings')}

              </div>
            </div>
          )}
        </div>

        <UpdateBadge />
      </div>
    </header>
  )
}
