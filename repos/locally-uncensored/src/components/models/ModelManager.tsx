import { useState, useEffect, useRef } from 'react'
import { motion } from 'framer-motion'
import {
  Download, ArrowLeft, RefreshCw, Search, MessageSquare, Image, Video,
  X as XIcon, HardDrive, Sparkles, PackageOpen,
} from 'lucide-react'
import { useModels } from '../../hooks/useModels'
import { useUIStore } from '../../stores/uiStore'
import { useProviderStore } from '../../stores/providerStore'
import { ModelCard } from './ModelCard'
import { PullModelDialog } from './PullModelDialog'
import { DiscoverModels } from './DiscoverModels'
import { Modal } from '../ui/Modal'
import { GlowButton } from '../ui/GlowButton'
import { showModel } from '../../api/ollama'
import type { ModelCategory, AIModel } from '../../types/models'

// Three-mode filter shared by both Installed and Discover banners. There is no
// "All" tab — the Installed view shows the active mode's section instead, so
// the toggle stays a clean three-choice control.
type Mode = Extract<ModelCategory, 'text' | 'image' | 'video'>

const MODE_TABS: { key: Mode; label: string; icon: typeof MessageSquare; accent: string }[] = [
  { key: 'text',  label: 'Text',  icon: MessageSquare, accent: 'text-blue-400' },
  { key: 'image', label: 'Image', icon: Image,         accent: 'text-purple-400' },
  { key: 'video', label: 'Video', icon: Video,         accent: 'text-emerald-400' },
]

export function ModelManager() {
  const { models, activeModel, setActiveModel, fetchModels, removeModel, categoryFilter, setCategoryFilter } = useModels()
  const { setView } = useUIStore()
  const ollamaEnabled = useProviderStore(s => s.providers.ollama.enabled)
  const [pullOpen, setPullOpen] = useState(false)
  const [infoOpen, setInfoOpen] = useState(false)
  const [modelInfo, setModelInfo] = useState<any>(null)
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null)
  // Open Model Manager on Discover by default — most opens are to find and
  // install something new. Installed (right icon) is one click away.
  const [tab, setTab] = useState<'installed' | 'discover'>('discover')

  // Discover-specific mode lives in the parent so the centered banner row
  // (rendered outside the max-w-4xl column) stays in sync with the view.
  const [discoverMode, setDiscoverMode] = useState<Mode>('text')

  // Inline search lives in the header — the magnifier toggles a sliding input
  // that submits to Discover (live filter + HF catalog search on Enter).
  const [searchOpen, setSearchOpen] = useState(false)
  const [searchQuery, setSearchQuery] = useState('')
  const [searchSubmitToken, setSearchSubmitToken] = useState(0)
  const searchInputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (searchOpen) searchInputRef.current?.focus()
  }, [searchOpen])

  // The store still defaults categoryFilter to 'all' for legacy reasons, but
  // the All tab is gone — coerce to 'text' on mount so the user never lands
  // on an unselected state.
  useEffect(() => {
    if (categoryFilter === 'all') setCategoryFilter('text')
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // The Installed banner is driven by the same Mode tuple as Discover.
  const installedMode: Mode = (categoryFilter === 'text' || categoryFilter === 'image' || categoryFilter === 'video')
    ? categoryFilter
    : 'text'

  useEffect(() => {
    fetchModels()
  }, [fetchModels])

  const handleInfo = async (name: string) => {
    try {
      const info = await showModel(name)
      setModelInfo({ name, ...info })
      setInfoOpen(true)
    } catch {
      // ignore
    }
  }

  const handleDelete = async (name: string) => {
    await removeModel(name)
    setConfirmDelete(null)
  }

  const filteredModels = models.filter((m: AIModel) => m.type === installedMode)

  // ── Render ──────────────────────────────────────────────────────

  return (
    <div className="h-full overflow-y-auto scrollbar-thin p-4">
      {/* Header — bounded to the same column as the model list so the back
          arrow and title line up with the cards beneath. */}
      <div className="max-w-4xl mx-auto">
        <div className="flex items-center justify-between mb-4">
          <div className="flex items-center gap-2">
            <button
              onClick={() => setView('chat')}
              className="p-1 rounded-lg hover:bg-gray-100 dark:hover:bg-white/10 text-gray-500 dark:text-gray-400 hover:text-gray-900 dark:hover:text-white transition-colors"
            >
              <ArrowLeft size={16} />
            </button>
            <h1 className="text-[0.8rem] font-semibold text-gray-800 dark:text-gray-200">Model Manager</h1>

            {/* Mode toggle — Discover (left) · Installed (right). */}
            <div className="ml-1 flex items-center gap-0.5 p-0.5 rounded-lg bg-gray-100 dark:bg-white/[0.04] border border-gray-200 dark:border-white/[0.06]">
              <button
                onClick={() => setTab('discover')}
                title="Discover new models"
                aria-pressed={tab === 'discover'}
                className={`flex items-center justify-center w-[26px] h-[20px] rounded-md transition-colors ${
                  tab === 'discover'
                    ? 'bg-white dark:bg-white/10 text-amber-500 dark:text-amber-300 shadow-sm'
                    : 'text-gray-500 hover:text-gray-700 dark:hover:text-gray-300'
                }`}
              >
                <Sparkles size={11} />
              </button>
              <button
                onClick={() => setTab('installed')}
                title={`Installed — ${models.length} model${models.length === 1 ? '' : 's'}`}
                aria-pressed={tab === 'installed'}
                className={`flex items-center gap-1 px-1.5 py-0.5 rounded-md transition-colors ${
                  tab === 'installed'
                    ? 'bg-white dark:bg-white/10 text-blue-500 dark:text-blue-400 shadow-sm'
                    : 'text-gray-500 hover:text-gray-700 dark:hover:text-gray-300'
                }`}
              >
                <HardDrive size={11} />
                <span className="text-[0.55rem] font-semibold">{models.length}</span>
              </button>
            </div>
          </div>

          <div className="flex items-center gap-1.5">
            {/* Sliding search input */}
            <div className={`flex items-center transition-[width,opacity] duration-200 ease-out overflow-hidden ${
              searchOpen ? 'w-48 opacity-100' : 'w-0 opacity-0'
            }`}>
              <input
                ref={searchInputRef}
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') { setTab('discover'); setSearchSubmitToken((t) => t + 1) }
                  else if (e.key === 'Escape') { setSearchQuery(''); setSearchOpen(false) }
                }}
                onBlur={() => { if (!searchQuery) setSearchOpen(false) }}
                placeholder="Search models…"
                className="w-full px-2.5 py-1 rounded-md bg-gray-100 dark:bg-white/5 border border-gray-200 dark:border-white/10 text-[0.65rem] text-gray-900 dark:text-white placeholder-gray-500 focus:outline-none focus:border-gray-400 dark:focus:border-white/20"
              />
            </div>
            <button
              onClick={() => {
                if (searchOpen && searchQuery) { setSearchQuery(''); setSearchOpen(false) }
                else setSearchOpen((o) => !o)
              }}
              title={searchOpen ? (searchQuery ? 'Clear search' : 'Close search') : 'Search models'}
              className="p-1.5 rounded-lg hover:bg-gray-100 dark:hover:bg-white/10 text-gray-500 hover:text-gray-900 dark:hover:text-white transition-colors"
              aria-label="Search models"
            >
              {searchOpen && searchQuery ? <XIcon size={13} /> : <Search size={13} />}
            </button>

            <button onClick={fetchModels} className="p-1.5 rounded-lg hover:bg-gray-100 dark:hover:bg-white/10 text-gray-500 hover:text-gray-900 dark:hover:text-white transition-colors" title="Refresh">
              <RefreshCw size={13} />
            </button>
            {ollamaEnabled && (
              <button
                onClick={() => setPullOpen(true)}
                className="flex items-center gap-1.5 px-2.5 py-1 rounded-lg bg-gray-100 dark:bg-white/5 border border-gray-200 dark:border-white/10 text-[0.65rem] text-gray-600 dark:text-gray-300 hover:bg-gray-200 dark:hover:bg-white/10 transition-colors"
              >
                <Download size={12} /> Pull Model
              </button>
            )}
          </div>
        </div>
      </div>

      {/* Banner — rendered OUTSIDE the max-w-4xl column so it sits at the true
          horizontal centre of the view. */}
      <div className="flex justify-center items-center gap-2 mb-5">
        <div className="flex gap-0.5 p-0.5 bg-gray-100 dark:bg-white/[0.04] rounded-lg border border-gray-200 dark:border-white/[0.06]">
          {MODE_TABS.map(({ key, label, icon: Icon, accent }) => {
            const active = tab === 'installed' ? installedMode === key : discoverMode === key
            const count = tab === 'installed' ? models.filter((m) => m.type === key).length : null
            return (
              <button
                key={key}
                onClick={() => {
                  if (tab === 'installed') setCategoryFilter(key)
                  else setDiscoverMode(key)
                }}
                className={`flex items-center gap-1 px-2 py-1 rounded-md text-[0.6rem] font-medium transition-all ${
                  active
                    ? 'bg-white dark:bg-white/10 text-gray-900 dark:text-white shadow-sm'
                    : 'text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-300'
                }`}
              >
                <Icon size={10} className={active ? accent : ''} />
                <span>{label}</span>
                {count !== null && (
                  <span className={`text-[0.55rem] font-normal ${active ? 'text-gray-400 dark:text-gray-500' : 'text-gray-400 dark:text-gray-600'}`}>
                    {count}
                  </span>
                )}
              </button>
            )
          })}
        </div>
      </div>

      {/* Content column */}
      <div className="max-w-4xl mx-auto">
        {tab === 'installed' && (
          <>
            {models.length === 0 ? (
              <div className="flex flex-col items-center justify-center text-center py-16 px-6 gap-3">
                <div className="w-14 h-14 rounded-full bg-gray-100 dark:bg-white/[0.04] border border-gray-200 dark:border-white/[0.06] flex items-center justify-center">
                  <PackageOpen size={22} className="text-gray-400 dark:text-gray-500" />
                </div>
                <div className="space-y-1">
                  <p className="text-[0.75rem] font-medium text-gray-800 dark:text-gray-200">No models installed yet</p>
                  <p className="text-[0.6rem] text-gray-500 max-w-[280px] leading-relaxed">
                    Browse curated text, image and video models in Discover and install them with one click.
                  </p>
                </div>
                <button
                  onClick={() => setTab('discover')}
                  className="flex items-center gap-1.5 mt-1 px-3 py-1.5 rounded-md bg-gray-900 dark:bg-white/10 hover:bg-gray-800 dark:hover:bg-white/15 text-white text-[0.65rem] font-medium transition-colors"
                >
                  <Sparkles size={11} /> Discover models
                </button>
              </div>
            ) : filteredModels.length === 0 ? (
              <div className="text-center py-10 space-y-2">
                <p className="text-[0.7rem] text-gray-500">
                  No {installedMode} models installed
                </p>
                <button
                  onClick={() => setTab('discover')}
                  className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md bg-gray-100 dark:bg-white/5 border border-gray-200 dark:border-white/10 text-[0.65rem] text-gray-700 dark:text-gray-300 hover:bg-gray-200 dark:hover:bg-white/10 transition-colors"
                >
                  <Sparkles size={11} /> Discover {installedMode} models
                </button>
              </div>
            ) : (
              (() => {
                const meta = MODE_TABS.find((s) => s.key === installedMode)!
                const SectionIcon = meta.icon
                return (
                  <section className="space-y-1.5">
                    <div className="flex items-center gap-2 px-1">
                      <SectionIcon size={11} className={meta.accent} />
                      <h2 className="text-[0.62rem] font-semibold uppercase tracking-[0.12em] text-gray-700 dark:text-gray-300">
                        {meta.label}
                      </h2>
                      <span className="text-[0.55rem] text-gray-400 dark:text-gray-500 tabular-nums">{filteredModels.length}</span>
                      <div className="flex-1 h-px bg-gray-200 dark:bg-white/[0.06]" />
                    </div>
                    <div className="space-y-1.5">
                      {filteredModels.map((model, i) => (
                        <motion.div
                          key={model.name}
                          initial={{ opacity: 0, y: 4 }}
                          animate={{ opacity: 1, y: 0 }}
                          transition={{ delay: i * 0.015 }}
                        >
                          <ModelCard
                            model={model}
                            isActive={model.name === activeModel}
                            onSelect={() => setActiveModel(model.name)}
                            onDelete={() => setConfirmDelete(model.name)}
                            onInfo={() => handleInfo(model.name)}
                            canDelete={ollamaEnabled && model.type === 'text' && (!('provider' in model) || model.provider === 'ollama')}
                          />
                        </motion.div>
                      ))}
                    </div>
                  </section>
                )
              })()
            )}
          </>
        )}

        {tab === 'discover' && (
          <DiscoverModels
            category={discoverMode}
            search={searchQuery}
            searchSubmitToken={searchSubmitToken}
          />
        )}
      </div>

      <PullModelDialog open={pullOpen} onClose={() => setPullOpen(false)} />

      <Modal open={!!confirmDelete} onClose={() => setConfirmDelete(null)} title="Delete Model">
        <p className="text-[0.7rem] text-gray-600 dark:text-gray-300 mb-3">
          Are you sure you want to delete <span className="text-gray-900 dark:text-white font-mono">{confirmDelete}</span>?
        </p>
        <div className="flex gap-2">
          <GlowButton variant="secondary" onClick={() => setConfirmDelete(null)} className="flex-1">
            Cancel
          </GlowButton>
          <GlowButton variant="danger" onClick={() => confirmDelete && handleDelete(confirmDelete)} className="flex-1">
            Delete
          </GlowButton>
        </div>
      </Modal>

      <Modal open={infoOpen} onClose={() => setInfoOpen(false)} title={modelInfo?.name || 'Model Info'}>
        {modelInfo && (
          <pre className="text-[0.6rem] text-gray-600 dark:text-gray-300 bg-gray-100 dark:bg-black/30 rounded-lg p-3 overflow-auto max-h-80 scrollbar-thin font-mono">
            {JSON.stringify(modelInfo, null, 2)}
          </pre>
        )}
      </Modal>
    </div>
  )
}
