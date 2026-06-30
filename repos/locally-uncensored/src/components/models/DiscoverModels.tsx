import { useState, useEffect } from 'react'
import { motion } from 'framer-motion'
import { Download, RefreshCw, ExternalLink, Search, CheckCircle, XCircle, Loader2 } from 'lucide-react'
import { X } from 'lucide-react'
import {
  searchHuggingFaceModels,
  getImageBundles, getVideoBundles,
  getUncensoredTextModels, getMainstreamTextModels,
  detectProviderModelPath, startModelDownloadToPath,
  startModelDownload, searchCivitaiModels,
  installBundleComplete, checkBundlesInstalled, resolveHfGgufFiles,
  type DiscoverModel, type DownloadProgress, type ModelBundle, type CivitAIModelResult, type HfGgufFile,
} from '../../api/discover'
import { getSystemVRAM } from '../../api/comfyui'
import { openExternal } from '../../api/backend'
import { useModels } from '../../hooks/useModels'
import { useDownloadStore } from '../../stores/downloadStore'
import { useProviderStore } from '../../stores/providerStore'
import { useSettingsStore } from '../../stores/settingsStore'
import { useModelStore } from '../../stores/modelStore'
import { useWorkflowStore } from '../../stores/workflowStore'
import { getProviderIdFromModel } from '../../api/providers'
import { matchesLmStudioInstalled, type InstalledModelLike } from '../../lib/lmstudio-match'
import { hfUrlToOllamaRef, hfUrlToLmStudioSubdir, parseHfUrl, extractGgufQuant, isShardedOrIncompatibleGguf } from '../../lib/hf-to-provider'
import { GlassCard } from '../ui/GlassCard'
import { GlowButton } from '../ui/GlowButton'
import { ProgressBar } from '../ui/ProgressBar'
import { Modal } from '../ui/Modal'
import { formatBytes } from '../../lib/formatters'
import type { ModelCategory } from '../../types/models'
import { proxyImageUrl } from '../../lib/privacy'
import { log } from '../../lib/logger'

interface Props {
  category: ModelCategory
  /** Filter query driven by the ModelManager header search input. */
  search?: string
  /** Bumped by ModelManager whenever the user submits the search (Enter). */
  searchSubmitToken?: number
}

function ModelDiscoverCard({ model, index, isText, getModelDownloadState, isModelFullyInstalled, handleDownload }: {
  model: DiscoverModel
  index: number
  isText: boolean
  getModelDownloadState: (m: DiscoverModel) => DownloadProgress | null
  isModelFullyInstalled: (model: DiscoverModel) => boolean
  handleDownload: (m: DiscoverModel) => void
}) {
  const dlState = getModelDownloadState(model)
  const isDownloading = dlState?.status === 'downloading' || dlState?.status === 'connecting'
  const isComplete = dlState?.status === 'complete'
  const canDirectDownload = (!!model.downloadUrl && !!model.filename) || !!model.ollamaModel

  return (
    <motion.div
      initial={{ opacity: 0, y: 10 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ delay: index * 0.03 }}
    >
      <div className="rounded-lg border border-gray-200 dark:border-white/[0.06] bg-gray-50 dark:bg-white/[0.03] p-3 transition-colors hover:bg-gray-100 dark:hover:bg-white/[0.05]">
        <div className="flex items-start justify-between gap-2">
          <div className="flex-1 min-w-0">
            <h3 className="text-sm font-medium text-gray-900 dark:text-white flex items-center gap-1.5 flex-wrap">
              {isModelFullyInstalled(model) && <span className="text-[0.55rem] px-1.5 py-0.5 rounded bg-green-500/15 text-green-500 font-bold border border-green-500/30 shrink-0">INSTALLED</span>}
              {model.hot && !isModelFullyInstalled(model) && <span className="text-[0.55rem] px-1.5 py-0.5 rounded bg-orange-500/15 text-orange-500 font-bold border border-orange-500/30 shrink-0">HOT</span>}
              {model.agent && <span className="text-[0.55rem] px-1.5 py-0.5 rounded bg-green-500/15 text-green-500 font-bold border border-green-500/30 shrink-0">AGENT</span>}
              {/* F4 (juliandiggins-stack GH#21) — explicit CPU-only / ≤8 GB RAM badge.
                  Pinned to a small curated set of uncensored models that we have
                  test-loaded on an 8 GB box without a discrete GPU. */}
              {model.lightweight && (
                <span
                  className="text-[0.55rem] px-1.5 py-0.5 rounded bg-emerald-500/15 text-emerald-500 font-bold border border-emerald-500/30 shrink-0"
                  title="Runs on 8 GB RAM, CPU-only. No discrete GPU required."
                >
                  CPU-FRIENDLY
                </span>
              )}
              <span>{model.description || model.name}</span>
            </h3>
            <p className="text-xs text-gray-400 dark:text-gray-500 mt-0.5 truncate">{model.name}</p>
            <div className="flex items-center gap-2 mt-1.5 flex-wrap">
              {model.tags.map((tag) => (
                <span key={tag} className="text-[10px] px-1.5 py-0.5 rounded bg-gray-100 dark:bg-white/5 text-gray-600 dark:text-gray-400">
                  {tag}
                </span>
              ))}
              {model.sizeGB && (
                <span className="text-[10px] text-gray-400">{model.sizeGB} GB</span>
              )}
              {model.pulls && (
                <span className="text-[10px] text-gray-500">{model.pulls}</span>
              )}
            </div>

            {/* Download progress shown exclusively in DownloadBadge (header) */}
          </div>

          <div className="flex items-center gap-1 shrink-0">
            {isText && model.canPull === false ? (
              <>
                <span className="text-xs text-green-500 px-2 py-1 rounded bg-green-500/10">Available</span>
                {model.url && (
                  <button
                    onClick={() => openExternal(model.url!)}
                    className="p-2 rounded-lg hover:bg-gray-100 dark:hover:bg-white/10 text-gray-500 transition-all"
                    title="View on HuggingFace"
                    aria-label="View on HuggingFace"
                  >
                    <ExternalLink size={14} />
                  </button>
                )}
              </>
            ) : isText && canDirectDownload ? (
              /* HuggingFace GGUF: direct download button */
              isComplete ? (
                <span className="flex items-center gap-1 text-xs text-green-500 px-2 py-1">
                  <CheckCircle size={12} /> Downloaded
                </span>
              ) : isDownloading ? (
                <span className="p-2 text-gray-400">
                  <Loader2 size={14} className="animate-spin" />
                </span>
              ) : (
                <button
                  onClick={() => handleDownload(model)}
                  className="p-2 rounded-lg bg-green-100 dark:bg-green-500/15 hover:bg-green-200 dark:hover:bg-green-500/25 text-green-700 dark:text-green-400 transition-all"
                  title={`Download ${model.sizeGB ? model.sizeGB + ' GB' : ''}`}
                >
                  <Download size={14} />
                </button>
              )
            ) : !isText ? (
              <>
                {isComplete ? (
                  <span className="flex items-center gap-1 text-xs text-green-500 px-2 py-1">
                    <CheckCircle size={12} /> Installed
                  </span>
                ) : isDownloading ? (
                  <span className="p-2 text-gray-400">
                    <Loader2 size={14} className="animate-spin" />
                  </span>
                ) : canDirectDownload ? (
                  <button
                    onClick={() => handleDownload(model)}
                    className="p-2 rounded-lg bg-green-100 dark:bg-green-500/15 hover:bg-green-200 dark:hover:bg-green-500/25 text-green-700 dark:text-green-400 transition-all"
                    title={`Download ${model.sizeGB ? model.sizeGB + ' GB' : ''} to ComfyUI`}
                  >
                    <Download size={14} />
                  </button>
                ) : null}
                {model.url && (
                  <button onClick={() => openExternal(model.url!)} className="p-2 rounded-lg hover:bg-gray-100 dark:hover:bg-white/10 text-gray-500 transition-all" title="View on website">
                    <ExternalLink size={14} />
                  </button>
                )}
              </>
            ) : null}
          </div>
        </div>
      </div>
    </motion.div>
  )
}

export function DiscoverModels({ category, search = '', searchSubmitToken = 0 }: Props) {
  const [civitaiResults, setCivitaiResults] = useState<CivitAIModelResult[]>([])
  const [civitaiSearching, setCivitaiSearching] = useState(false)
  const [civitaiQuery, setCivitaiQuery] = useState('')
  // Track whether the *latest* CivitAI search has been issued at least once,
  // so an empty-state hint can render between "before-first-search" and
  // "search returned 0 hits". Without this we fall through to the silent gap
  // diimmortalis described — empty list, no console output, looks like the
  // button did nothing.
  const [civitaiSearched, setCivitaiSearched] = useState(false)
  // CivitAI mirror host (#53) — civitai.red for regions where .com is blocked.
  const civitaiHost = useWorkflowStore((s) => s.civitaiHost)
  const setCivitaiHost = useWorkflowStore((s) => s.setCivitaiHost)
  const [loading, setLoading] = useState(false)
  const [systemVRAM, setSystemVRAM] = useState<number | null>(null)
  const [subTab, setSubTab] = useState<'uncensored' | 'mainstream'>('uncensored')
  // Weight-class categories (David 2026-06-06): four size buckets so every
  // model lands in exactly one class — Ultra Lightweight ≤4 GB, Lightweight
  // 4–10 GB, Middleweight 10–20 GB, High-End >20 GB (open-ended). Replaces the
  // older 3-tier lightweight/mid/highend VRAM filter.
  const [vramTier, setVramTier] = useState<'all' | 'ultra' | 'light' | 'middle' | 'highend'>('all')
  const downloads = useDownloadStore(s => s.downloads)
  const dlStore = useDownloadStore

  // Provider state for model path detection
  const providers = useProviderStore(s => s.providers)
  const hfOverride = useSettingsStore(s => s.settings.hfDownloadPathOverride)
  // Bug Y/a v2.5.0 — Aldrich Ironhart Discord. We need to know which provider
  // the user is actually chatting against, not just which one is enabled,
  // because both can be enabled at once and the active picker decides where
  // the file should land. `activeModel` is `<providerId>::<id>` for non-Ollama
  // backends and a bare name for Ollama.
  const activeChatModel = useModelStore(s => s.activeModel)
  const [hfModelPath, setHfModelPath] = useState<string | null>(null)
  const { pullModel, models: installedModels, fetchModels } = useModels()

  // Refresh installed-model list on mount + when category switches to text
  // so the Discover grid reflects what Ollama / LM Studio actually have on
  // disk (Bug #43: text-models never showed "Installed" because we only
  // checked the in-memory download-store, which is empty after a restart).
  useEffect(() => {
    if (category === 'text') fetchModels().catch(() => {})
  }, [category, fetchModels])

  // Auto-detect provider model path for GGUF downloads (user override wins).
  useEffect(() => {
    if (category !== 'text') return
    const override = hfOverride?.trim()
    if (override) { setHfModelPath(override); return }
    const providerName = providers.openai?.name || 'LM Studio'
    detectProviderModelPath(providerName).then(path => setHfModelPath(path))
  }, [category, hfOverride, providers.openai?.name])

  // Detect system VRAM
  useEffect(() => {
    getSystemVRAM().then(v => setSystemVRAM(v))
  }, [])

  // Check which bundles are REALLY installed (file size validated, not just file existence)
  const [bundleStatuses, setBundleStatuses] = useState<Record<string, boolean>>({})
  const refreshBundleStatuses = () => {
    if (category !== 'image' && category !== 'video') return
    const allBundles = [...getImageBundles(), ...getVideoBundles()]
    checkBundlesInstalled(allBundles).then(statuses => setBundleStatuses(statuses))
  }
  useEffect(() => {
    refreshBundleStatuses()
  }, [category])

  // Re-check bundle statuses when a download completes
  useEffect(() => {
    const handler = () => refreshBundleStatuses()
    window.addEventListener('comfyui-model-downloaded', handler)
    return () => window.removeEventListener('comfyui-model-downloaded', handler)
  }, [category])

  // Start polling on mount if there are active downloads
  useEffect(() => {
    dlStore.getState().refresh()
  }, [])

  const isText = category === 'text'
  const isImage = category === 'image'
  const isVideo = category === 'video'
  const bundles = isImage ? getImageBundles() : isVideo ? getVideoBundles() : []

  // Parse VRAM requirement string to minimum GB needed
  // "6-8 GB" → 8 (need at least the upper bound)
  // "12+ GB" → 13 (+ means MORE than that number)
  // "8 GB" → 8
  const parseVRAM = (s: string): number => {
    if (s.includes('+')) {
      const match = s.match(/(\d+)\+/)
      return match ? parseInt(match[1]) + 2 : 99 // "12+" means realistically 14+ GB needed
    }
    // Range like "6-8 GB" → take the upper number
    const range = s.match(/(\d+)\s*-\s*(\d+)/)
    if (range) return parseInt(range[2])
    const match = s.match(/(\d+)/)
    return match ? parseInt(match[1]) : 99
  }

  // Sort bundles: verified first, then HOT, then fits VRAM, then by size
  const sortedBundles = [...bundles].sort((a, b) => {
    // Verified models always first
    if (a.verified && !b.verified) return -1
    if (!a.verified && b.verified) return 1
    // HOT models next
    if (a.hot && !b.hot) return -1
    if (!a.hot && b.hot) return 1
    if (systemVRAM) {
      const aFits = parseVRAM(a.vramRequired) <= systemVRAM
      const bFits = parseVRAM(b.vramRequired) <= systemVRAM
      if (aFits && !bFits) return -1
      if (!aFits && bFits) return 1
    }
    return parseVRAM(a.vramRequired) - parseVRAM(b.vramRequired)
  })

  const tabFilteredBundles = sortedBundles.filter(b => subTab === 'uncensored' ? b.uncensored : !b.uncensored)

  // VRAM tier filtering for bundles
  const vramFilteredBundles = tabFilteredBundles.filter(b => {
    if (vramTier === 'all') return true
    const vram = parseVRAM(b.vramRequired)
    if (vramTier === 'ultra') return vram <= 4
    if (vramTier === 'light') return vram > 4 && vram <= 10
    if (vramTier === 'middle') return vram > 10 && vram <= 20
    return vram > 20 // highend (open-ended)
  })

  const filteredBundles = search
    ? vramFilteredBundles.filter((b) => b.name.toLowerCase().includes(search.toLowerCase()) || b.description.toLowerCase().includes(search.toLowerCase()))
    : vramFilteredBundles

  // Text-model installed check.
  //
  // Before v2.4.8 this only consulted the in-memory `downloads` store, so the
  // INSTALLED badge disappeared the moment the user restarted the app — which
  // is exactly what leonsk29 reported (GH #43). The store has no knowledge of
  // what Ollama / LM Studio actually have on disk, only of downloads that
  // happened in the current session.
  //
  // Fix: also match against the provider model list (which Ollama/LM Studio
  // populate from disk). For HF GGUFs the in-app download goes through
  // `ollama pull hf.co/<repo>:<quant>`, so the same canonical reference is
  // what we look up in the installed-list. Session downloads remain a valid
  // signal as the fastest-path (no fetchModels round-trip needed).
  const isModelFullyInstalled = (model: DiscoverModel) => {
    if (model.filename && downloads[model.filename]?.status === 'complete') return true

    const installedOllamaTags = installedModels
      .filter(m => m.provider === 'ollama')
      .map(m => (m.model || m.name || '').toLowerCase())

    if (model.ollamaModel) {
      const tag = model.ollamaModel.toLowerCase()
      if (installedOllamaTags.includes(tag)) return true
      // Ollama appends `:latest` to bare model names — accept either form
      if (!tag.includes(':') && installedOllamaTags.includes(`${tag}:latest`)) return true
    }

    if (model.filename && model.downloadUrl) {
      const ref = hfUrlToOllamaRef(model.downloadUrl, model.filename)?.toLowerCase()
      if (ref && installedOllamaTags.includes(ref)) return true
    }

    // Bug Y/b v2.5.0 — Aldrich Ironhart Discord. Pre-v2.5.0 isModelFullyInstalled
    // only checked Ollama tags. After a restart, GGUFs that LU itself wrote
    // to LM Studio's scan dir would never light up the INSTALLED badge,
    // because LM Studio surfaces them by file basename in the openai-compat
    // listing rather than by an Ollama-style hf.co tag. Match by filename
    // (case-insensitive, with/without trailing `.gguf`).
    // Match against LM Studio's installed models too (not just Ollama tags).
    // The matcher (lib/lmstudio-match.ts, unit-tested) handles both the older
    // full-basename id form AND LM Studio's modern quant-less publisher/short
    // key (e.g. "qwen/qwen2.5-vl-7b" vs "Qwen2.5-VL-7B-Instruct-Q4_K_M.gguf").
    if (model.filename && matchesLmStudioInstalled(model.filename, installedModels as unknown as InstalledModelLike[])) {
      return true
    }

    return false
  }

  const [installingBundle, setInstallingBundle] = useState<string | null>(null)
  const [installError, setInstallError] = useState<string | null>(null)
  // Confirmation gate for multi-part (sharded) downloads — these sets routinely
  // run hundreds of GB across many files, so we never start them silently.
  const [confirmDownload, setConfirmDownload] = useState<{ name: string; files: HfGgufFile[]; targetDir: string; totalGB: number; note?: string } | null>(null)

  // Download a resolved file-set straight into one folder (llama.cpp / LM Studio
  // merge multi-part `-NNNNN-of-NNNNN` GGUFs that share a directory).
  const startDirectDownload = async (files: HfGgufFile[], targetDir: string, groupName: string) => {
    const names = files.map(f => f.filename)
    if (names.length > 1) dlStore.getState().setBundleGroup(groupName, names)
    for (const f of files) {
      dlStore.getState().setMeta(f.filename, f.url, 'gguf', targetDir)
      await startModelDownloadToPath(f.url, targetDir, f.filename, f.sizeBytes || undefined)
    }
    dlStore.getState().startPolling()
  }

  const handleBundleInstall = async (bundle: ModelBundle) => {
    if (installingBundle === bundle.name) return // Prevent duplicate installs
    setInstallingBundle(bundle.name)
    setInstallError(null)
    const filenames: string[] = []
    for (const file of bundle.files) {
      if (file.downloadUrl && file.filename && file.subfolder) {
        dlStore.getState().setMeta(file.filename, file.downloadUrl, file.subfolder)
        filenames.push(file.filename)
      }
    }
    dlStore.getState().setBundleGroup(bundle.name, filenames)
    // Start polling BEFORE install so progress is tracked immediately
    dlStore.getState().startPolling()
    try {
      await installBundleComplete(bundle)
    } catch (err) {
      log.error('[DiscoverModels] Bundle install failed', { err })
      setInstallError(`${bundle.name}: ${err instanceof Error ? err.message : String(err)}`)
    }
    // Wait for polling to pick up at least one active download before clearing spinner
    // This prevents the "disappearing" UI — spinner stays until downloads are visible
    const waitForDownloads = () => {
      const active = filenames.some(fn => {
        const dl = dlStore.getState().downloads[fn]
        return dl && (dl.status === 'downloading' || dl.status === 'connecting' || dl.status === 'complete')
      })
      if (active) {
        setInstallingBundle(null)
      } else {
        setTimeout(waitForDownloads, 500)
      }
    }
    setTimeout(waitForDownloads, 1000)
  }

  const handleCivitaiSearch = async () => {
    if (!civitaiQuery.trim()) return
    setCivitaiSearching(true)
    setCivitaiSearched(true)
    // Reuse the CivitAI API key the user already configured for the Workflow
    // finder. The model search and the workflow finder share the same backend
    // credential, so plumbing a separate input here would just confuse users.
    const apiKey = useWorkflowStore.getState().civitaiApiKey || undefined
    const host = useWorkflowStore.getState().civitaiHost
    const results = await searchCivitaiModels(civitaiQuery, 'Checkpoint', apiKey, host)
    setCivitaiResults(results)
    setCivitaiSearching(false)
  }

  const handleCivitaiDownload = async (model: CivitAIModelResult) => {
    if (!model.downloadUrl || !model.filename || !model.subfolder) return
    dlStore.getState().setMeta(model.filename, model.downloadUrl, model.subfolder)
    await startModelDownload(model.downloadUrl, model.subfolder, model.filename)
    dlStore.getState().startPolling()
  }

  const isBundleComplete = (bundle: ModelBundle): boolean => {
    // If any file has error status, bundle is NOT complete
    const hasError = bundle.files.some(f => f.filename && downloads[f.filename]?.status === 'error')
    if (hasError) return false
    // Check 1: Download store says all files complete (current session downloads)
    const dlComplete = bundle.files.every(f => f.filename && downloads[f.filename]?.status === 'complete')
    if (dlComplete) return true
    // Check 2: Disk check says all files are complete (size validated)
    return bundleStatuses[bundle.name] === true
  }

  const isBundleDownloading = (bundle: ModelBundle): boolean => {
    return bundle.files.some(f => f.filename && (downloads[f.filename]?.status === 'downloading' || downloads[f.filename]?.status === 'connecting'))
  }

  const hasBundleErrors = (bundle: ModelBundle): boolean => {
    // Check for explicit error status in download store
    if (bundle.files.some(f => f.filename && downloads[f.filename]?.status === 'error')) return true
    // Also check: some files show complete in store but bundle is NOT fully installed on disk
    // This catches the case where error entries were dismissed but the bundle is still incomplete
    const hasAnyDownloadEntry = bundle.files.some(f => f.filename && downloads[f.filename])
    if (hasAnyDownloadEntry && !bundleStatuses[bundle.name]) {
      const someComplete = bundle.files.some(f => f.filename && downloads[f.filename]?.status === 'complete')
      const allComplete = bundle.files.every(f => f.filename && downloads[f.filename]?.status === 'complete')
      if (someComplete && !allComplete) return true
    }
    return false
  }

  const getModelDownloadState = (model: DiscoverModel): DownloadProgress | null => {
    if (!model.filename) return null
    return downloads[model.filename] ?? null
  }

  // Progress calculation moved to DownloadBadge in Header

  const [hfSearchResults, setHfSearchResults] = useState<DiscoverModel[]>([])

  const handleSearch = async () => {
    if (!search.trim() || !isText) return
    setLoading(true)
    try {
      const results = await searchHuggingFaceModels(search.trim())
      setHfSearchResults(results)
    } catch { /* keep existing */ }
    setLoading(false)
  }

  // The search input now lives in the ModelManager header (uselu arrangement).
  // It feeds `search` (live filter) and bumps `searchSubmitToken` on Enter,
  // which we treat as "run the HuggingFace catalog search".
  useEffect(() => {
    if (searchSubmitToken > 0 && search.trim() && isText) handleSearch()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchSubmitToken])

  const uncensoredModels = isText ? getUncensoredTextModels() : []
  const mainstreamModels = isText ? getMainstreamTextModels() : []

  // Apply the VRAM tier filter to text models too (Feature 46, leonsk29 GH #46).
  // We use the model's GGUF `sizeGB` as a proxy for VRAM need — Q4 quants run
  // entirely on the GPU when sizeGB ≤ VRAM, so the same lightweight/mid/highend
  // bucketing as image/video applies here. Models without a `sizeGB` (cloud
  // / canPull:false placeholders) bypass the filter and always show.
  const matchesVramTier = (sizeGB?: number) => {
    if (vramTier === 'all') return true
    if (sizeGB === undefined || sizeGB === null) return true
    if (vramTier === 'ultra') return sizeGB <= 4
    if (vramTier === 'light') return sizeGB > 4 && sizeGB <= 10
    if (vramTier === 'middle') return sizeGB > 10 && sizeGB <= 20
    return sizeGB > 20 // highend (open-ended)
  }

  const matchesSearch = (m: DiscoverModel) =>
    !search ||
    m.name.toLowerCase().includes(search.toLowerCase()) ||
    m.description.toLowerCase().includes(search.toLowerCase())

  const filteredUncensored = uncensoredModels.filter(m => matchesSearch(m) && matchesVramTier(m.sizeGB))
  const filteredMainstream = mainstreamModels.filter(m => matchesSearch(m) && matchesVramTier(m.sizeGB))

  // Turn a raw Ollama pull error into actionable guidance. Sharded/split GGUF
  // repos (model split into multiple .gguf parts) make `ollama pull` 400 —
  // Ollama can't pull split GGUF yet (ollama/ollama#5245). Don't show the user
  // a cryptic HTTP 400; tell them what to do.
  const formatPullError = (modelName: string, err: unknown): string => {
    const msg = err instanceof Error ? err.message : String(err)
    // Sharded / "not compatible with llama.cpp" repos genuinely can't go via
    // Ollama (ollama/ollama#5245) — point at LM Studio.
    if (isShardedOrIncompatibleGguf(msg)) {
      return `${modelName} can't be pulled into Ollama — its HuggingFace repo is split into parts or isn't a flat single-file GGUF. Download it via LM Studio instead (it loads sharded GGUF fine), or pick a single-file quant.`
    }
    // A bare HTTP 400 from `ollama pull hf.co/...` is usually an OUT-OF-DATE
    // Ollama (HF-pull support is version-gated) — the same ref succeeds on
    // current Ollama. Tell the user instead of surfacing "ollama: 400"
    // (Aldrich Ironhart, Discord 2026-06-07: "Gemma 4 26B MoE → ollama: 400").
    if (/\b400\b/.test(msg)) {
      return `Ollama rejected the download of ${modelName} (HTTP 400). This is almost always an out-of-date Ollama — update it from ollama.com/download and retry. Otherwise download via LM Studio, or pick a single-file quant.`
    }
    return `Download failed: ${msg}`
  }

  const handleTextDownload = async (model: DiscoverModel) => {
    // Bug Y/a v2.5.0 — Aldrich Ironhart Discord. Pre-v2.5.0 we picked the
    // download backend by "whichever is enabled" with LM Studio winning when
    // both were on. That decoupled the download path from the active chat
    // picker: a user chatting on LM Studio could click Download and the
    // file would land in Ollama's store (or vice versa), invisible to the
    // chat side. Fix: derive the target backend from the *active chat
    // model*. If no active model yet (first run, brand new install), fall
    // back to the previous enabled-wins logic so the download still works.
    const activeProviderId = activeChatModel ? getProviderIdFromModel(activeChatModel) : null
    const isActiveLmStudio = activeProviderId === 'openai' && (providers.openai?.name || '').toLowerCase().includes('lm studio')
    const isActiveOllama = activeProviderId === 'ollama'

    // Ollama-native models: only meaningful with Ollama present. If the user
    // is chatting on LM Studio and clicks one of these (e.g. Qwen3.6 35B
    // listed only by Ollama tag), warn instead of silently pulling into a
    // backend the user can't see from chat.
    if (model.ollamaModel) {
      const ollamaOn = !!providers.ollama?.enabled
      if (!ollamaOn) {
        setInstallError(`${model.name} is an Ollama-only model. Enable the Ollama provider (Settings → Providers) before downloading.`)
        return
      }
      if (activeProviderId && !isActiveOllama) {
        setInstallError(`${model.name} can only run on Ollama. Switch the chat picker to an Ollama model first, then download.`)
        return
      }
      try {
        await pullModel(model.ollamaModel)
      } catch (e) {
        log.error('Ollama pull failed', { err: e })
        setInstallError(formatPullError(model.name, e))
      }
      return
    }
    if (!model.downloadUrl || !model.filename) return

    // Resolve the REAL file(s) on HuggingFace before downloading. The curated /
    // search-derived (url, filename) is only a *guess* — the repo may host the
    // quant in a subfolder, split it into multiple parts, or not have that
    // exact filename. Querying the tree turns the guess into the truth.
    const parsed = parseHfUrl(model.downloadUrl)
    const preferredQuant = extractGgufQuant(model.filename)
    const resolution = parsed
      ? await resolveHfGgufFiles(`${parsed.user}/${parsed.repo}`, preferredQuant)
      : null

    const lmStudioEnabled = !!providers.openai?.enabled && (providers.openai?.name || '').toLowerCase().includes('lm studio')
    const ollamaEnabledNow = !!providers.ollama?.enabled

    // Resolve the LM Studio-style destination dir for any direct download.
    // LM Studio scans <models>/<user>/<repo>/<file>.gguf and llama.cpp
    // auto-merges every `-NNNNN-of-NNNNN` part it finds in one folder.
    const ensureDirectDir = async (): Promise<string | null> => {
      const base = hfModelPath || (await detectProviderModelPath(providers.openai?.name || 'LM Studio'))
      if (!base) return null
      setHfModelPath(base)
      const subdir = hfUrlToLmStudioSubdir(model.downloadUrl!)
      return subdir ? `${base}/${subdir}` : base
    }

    // ── Sharded / multi-part: `ollama pull` cannot load split GGUF
    // (ollama/ollama#5245), so the only sound path is a direct multi-part
    // download into the LM Studio dir where llama.cpp merges the parts. These
    // sets are often hundreds of GB (e.g. GLM-5.1 UD-Q4_K_M = 11 files / 432 GB),
    // so we CONFIRM first — showing the part count + total size — instead of
    // silently kicking off a download the user's disk/VRAM can't sustain. ──
    if (resolution?.sharded) {
      const targetDir = await ensureDirectDir()
      if (!targetDir) {
        setInstallError('Could not determine model directory. Please check app permissions.')
        return
      }
      const ollamaCantLoad = isActiveOllama || (!isActiveLmStudio && !lmStudioEnabled && ollamaEnabledNow)
      setConfirmDownload({
        name: model.name,
        files: resolution.files,
        targetDir,
        totalGB: +(resolution.totalBytes / 1_073_741_824).toFixed(1),
        note: ollamaCantLoad
          ? `Ollama can't load split GGUF (#5245) — the parts go to your LM Studio models folder. Load it from LM Studio, or pick a single-file quant for Ollama.`
          : undefined,
      })
      return
    }

    // ── Single file. Use the resolved file when available (it corrects a wrong
    // guessed name / subfolder); else fall back to the guess so a transient HF
    // API outage doesn't block the download. ──
    const single = resolution?.files[0]
    const realUrl = single?.url || model.downloadUrl
    const realName = single?.filename || model.filename
    const realBytes = single?.sizeBytes || (model.sizeGB ? Math.round(model.sizeGB * 1_073_741_824) : undefined)

    // Route by the active chat model. If neither side has an active model yet
    // (first launch), fall back to the old enabled-wins logic.
    let useOllamaPath: boolean
    if (isActiveOllama) useOllamaPath = true
    else if (isActiveLmStudio) useOllamaPath = false
    else useOllamaPath = !lmStudioEnabled && ollamaEnabledNow // legacy fallback

    if (useOllamaPath) {
      const ref = hfUrlToOllamaRef(realUrl, realName)
      if (!ref) {
        setInstallError(`Cannot map ${model.name} to an Ollama HF reference — try LM Studio.`)
        return
      }
      try {
        await pullModel(ref)
      } catch (e) {
        log.error('Ollama HF pull failed', { err: e })
        setInstallError(formatPullError(model.name, e))
      }
      return
    }

    const targetDir = await ensureDirectDir()
    if (!targetDir) {
      setInstallError('Could not determine model directory. Please check app permissions.')
      return
    }
    try {
      dlStore.getState().setMeta(realName, realUrl, 'gguf', targetDir)
      await startModelDownloadToPath(realUrl, targetDir, realName, realBytes)
      dlStore.getState().startPolling()
    } catch (e) {
      log.error('GGUF download failed', { err: e })
      setInstallError(`Download failed: ${e instanceof Error ? e.message : String(e)}`)
    }
  }

  return (
    <div className="space-y-4">
      {/* Sub-tabs: Uncensored / Mainstream — for all text sources and image/video */}
      {(isText || isImage || isVideo) && (
        <div className="flex gap-4 mb-4">
          <button
            onClick={() => setSubTab('uncensored')}
            className={`flex items-center gap-2 transition-all ${
              subTab === 'uncensored' ? 'opacity-100' : 'opacity-40 hover:opacity-70'
            }`}
          >
            <div className={`w-1 h-5 rounded-full ${subTab === 'uncensored' ? 'bg-red-500' : 'bg-red-500/50'}`} />
            <span className="text-[0.75rem] font-semibold text-gray-900 dark:text-white uppercase tracking-wider">Uncensored</span>
            <span className="text-[0.55rem] text-gray-500">{isText ? 'No filters, no limits' : 'No content filter'}</span>
          </button>
          <button
            onClick={() => setSubTab('mainstream')}
            className={`flex items-center gap-2 transition-all ${
              subTab === 'mainstream' ? 'opacity-100' : 'opacity-40 hover:opacity-70'
            }`}
          >
            <div className={`w-1 h-5 rounded-full ${subTab === 'mainstream' ? 'bg-blue-500' : 'bg-blue-500/50'}`} />
            <span className="text-[0.75rem] font-semibold text-gray-900 dark:text-white uppercase tracking-wider">Mainstream</span>
            <span className="text-[0.55rem] text-gray-500">{isText ? 'Tool calling + vision' : 'Popular + high quality'}</span>
          </button>
        </div>
      )}

      {/* VRAM Tier Filter — image/video bundles AND text models (Feature 46,
          leonsk29 GH #46). Text models reuse the same tier thresholds, derived
          from each model's GGUF `sizeGB` (Q4 quant roughly equals VRAM need). */}
      {(isImage || isVideo || (isText && (uncensoredModels.length > 0 || mainstreamModels.length > 0))) && (
        <div className="flex gap-1.5">
          {([
            { key: 'all', label: 'All', desc: '' },
            { key: 'ultra', label: 'Ultra Lightweight', desc: '≤4 GB' },
            { key: 'light', label: 'Lightweight', desc: '4–10 GB' },
            { key: 'middle', label: 'Middleweight', desc: '10–20 GB' },
            { key: 'highend', label: 'High-End', desc: '>20 GB' },
          ] as const).map(tier => (
            <button
              key={tier.key}
              onClick={() => setVramTier(tier.key)}
              className={`px-2.5 py-1 rounded-full text-[11px] font-medium transition-all ${
                vramTier === tier.key
                  ? 'bg-white/15 text-white border border-white/20'
                  : 'text-gray-500 hover:text-gray-300 hover:bg-white/5'
              }`}
            >
              {tier.label}
              {tier.desc && <span className="text-[9px] text-gray-500 ml-1">{tier.desc}</span>}
            </button>
          ))}
        </div>
      )}

      {/* Install error banner */}
      {installError && (
        <div className="flex items-center gap-2 p-3 rounded-lg bg-red-500/10 border border-red-500/20 text-red-400 text-sm">
          <XCircle size={16} className="shrink-0" />
          <span className="flex-1">{installError}</span>
          <button onClick={() => setInstallError(null)} className="text-red-400 hover:text-red-300 shrink-0">
            <X size={14} />
          </button>
        </div>
      )}

      {/* Model Bundles (Image + Video) — same grid style as text models */}
      {(isImage || isVideo) && filteredBundles.length > 0 && (
        <div className="grid grid-cols-1 gap-2">
          {filteredBundles.map((bundle, bi) => {
            const complete = isBundleComplete(bundle)
            const downloading = isBundleDownloading(bundle) || installingBundle === bundle.name
            const isComingSoon = !bundle.verified && !complete

            return (
              <motion.div key={bundle.name} initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: bi * 0.03 }}>
                <div className={`rounded-lg border border-gray-200 dark:border-white/[0.06] bg-gray-50 dark:bg-white/[0.03] p-3 relative overflow-hidden transition-colors hover:bg-gray-100 dark:hover:bg-white/[0.05] ${isComingSoon ? 'opacity-50' : ''}`}>
                  {isComingSoon && (
                    <div className="absolute inset-0 z-10 flex items-center justify-center bg-black/40 backdrop-blur-[1px] rounded-lg">
                      <span className="px-3 py-1.5 rounded-full bg-white/10 border border-white/20 text-white text-xs font-semibold tracking-wider">
                        COMING SOON
                      </span>
                    </div>
                  )}
                  <div className="flex items-start justify-between gap-2">
                    <div className="flex-1 min-w-0">
                      <h3 className="text-sm font-medium text-gray-900 dark:text-white truncate flex items-center gap-1.5">
                        {complete && <span className="text-[0.55rem] px-1.5 py-0.5 rounded bg-green-500/15 text-green-500 font-bold border border-green-500/30 shrink-0">INSTALLED</span>}
                        {bundle.hot && !complete && <span className="text-[0.55rem] px-1.5 py-0.5 rounded bg-orange-500/15 text-orange-500 font-bold border border-orange-500/30 shrink-0">HOT</span>}
                        <span className="truncate">{bundle.name}</span>
                      </h3>
                      {bundle.description && (
                        <p className="text-xs text-gray-500 mt-0.5">{bundle.description}</p>
                      )}
                      <div className="flex items-center gap-2 mt-1.5 flex-wrap">
                        {bundle.tags.map(t => (
                          <span key={t} className="text-[10px] px-1.5 py-0.5 rounded bg-gray-100 dark:bg-white/5 text-gray-600 dark:text-gray-400">{t}</span>
                        ))}
                        {bundle.totalSizeGB && (
                          <span className="text-[10px] text-gray-400">{bundle.totalSizeGB} GB</span>
                        )}
                        <span className="text-[10px] text-gray-400">{bundle.files.length} files</span>
                        {systemVRAM && parseVRAM(bundle.vramRequired) <= systemVRAM && (
                          <span className="text-[10px] px-1.5 py-0.5 rounded bg-emerald-500/10 text-emerald-500 font-medium">Fits GPU</span>
                        )}
                      </div>

                      {/* Progress shown exclusively in DownloadBadge (header) */}
                    </div>

                    <div className="flex items-center gap-1 shrink-0">
                      {complete ? null : downloading ? (
                        <span className="p-2 text-gray-400">
                          <Loader2 size={14} className="animate-spin" />
                        </span>
                      ) : hasBundleErrors(bundle) ? (
                        <button
                          onClick={() => {
                            // Retry only the files that are NOT complete
                            for (const f of bundle.files) {
                              if (!f.filename || !f.downloadUrl || !f.subfolder) continue
                              const dl = downloads[f.filename]
                              // Retry if: explicit error, OR no download entry and not on disk
                              if (dl?.status === 'error') {
                                dlStore.getState().retry(f.filename)
                              } else if (!dl || (dl.status !== 'complete' && dl.status !== 'downloading' && dl.status !== 'connecting')) {
                                // File has no active download — start fresh
                                dlStore.getState().setMeta(f.filename, f.downloadUrl, f.subfolder)
                                startModelDownload(f.downloadUrl, f.subfolder, f.filename, f.sizeGB ? Math.round(f.sizeGB * 1_073_741_824) : undefined)
                                dlStore.getState().startPolling()
                              }
                            }
                          }}
                          className="flex items-center gap-1 px-2 py-1.5 rounded-lg bg-red-100 dark:bg-red-500/15 hover:bg-red-200 dark:hover:bg-red-500/25 text-red-700 dark:text-red-400 transition-all text-xs"
                          title="Retry failed downloads"
                        >
                          <RefreshCw size={12} />
                          <span>Retry</span>
                        </button>
                      ) : (
                        <button
                          onClick={() => handleBundleInstall(bundle)}
                          className="p-2 rounded-lg bg-green-100 dark:bg-green-500/15 hover:bg-green-200 dark:hover:bg-green-500/25 text-green-700 dark:text-green-400 transition-all"
                          title={`Install all ${bundle.files.length} files (${bundle.totalSizeGB} GB)`}
                        >
                          <Download size={14} />
                        </button>
                      )}
                      {bundle.url && (
                        <button onClick={() => openExternal(bundle.url!)} className="p-2 rounded-lg hover:bg-gray-100 dark:hover:bg-white/10 text-gray-500 transition-all" title="View on HuggingFace">
                          <ExternalLink size={14} />
                        </button>
                      )}
                    </div>
                  </div>
                </div>
              </motion.div>
            )
          })}
        </div>
      )}

      {(isImage || isVideo) && sortedBundles.length > 0 && filteredBundles.length === 0 && (
        <p className="text-center text-gray-500 py-4 text-sm">No models match this VRAM tier. Try a different filter.</p>
      )}

      {/* CivitAI Search (Image & Video) */}
      {(isImage || isVideo) && (
        <GlassCard className="p-4 space-y-3">
          <div className="flex items-center justify-between gap-2">
            <h3 className="text-sm font-semibold text-gray-900 dark:text-white">Search CivitAI</h3>
            {/* Mirror toggle (#53) — civitai.red for regions where .com is blocked. */}
            <div className="flex items-center gap-1 text-[10px]">
              <span className="text-gray-400 dark:text-gray-500 mr-0.5">mirror</span>
              {(['civitai.com', 'civitai.red'] as const).map((h) => (
                <button
                  key={h}
                  onClick={() => setCivitaiHost(h)}
                  title={h === 'civitai.red'
                    ? 'Use the civitai.red mirror — for regions where civitai.com is blocked'
                    : 'Use civitai.com (default)'}
                  className={
                    'px-1.5 py-0.5 rounded font-mono transition-colors ' +
                    (civitaiHost === h
                      ? 'bg-gray-200 dark:bg-white/15 text-gray-900 dark:text-white'
                      : 'text-gray-400 hover:text-gray-700 dark:hover:text-gray-200')
                  }
                >
                  {h.replace('civitai', '')}
                </button>
              ))}
            </div>
          </div>
          <div className="flex gap-2 w-1/2 mx-auto">
            <input
              value={civitaiQuery}
              onChange={(e) => setCivitaiQuery(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && handleCivitaiSearch()}
              placeholder="e.g. flux, sdxl realistic, anime..."
              className="flex-1 px-3 py-2 rounded-lg bg-gray-100 dark:bg-white/5 border border-gray-200 dark:border-white/10 text-sm text-gray-900 dark:text-white placeholder-gray-500 focus:outline-none focus:border-gray-400 dark:focus:border-white/20"
            />
            <button
              onClick={handleCivitaiSearch}
              disabled={civitaiSearching || !civitaiQuery.trim()}
              className="px-3 py-2 rounded-lg bg-gray-100 dark:bg-white/10 hover:bg-gray-200 dark:hover:bg-white/15 disabled:opacity-50 text-gray-700 dark:text-white transition-colors"
            >
              {civitaiSearching ? <Loader2 size={16} className="animate-spin" /> : <Search size={16} />}
            </button>
          </div>

          {civitaiResults.length > 0 && (
            <div className="space-y-2 max-h-[50vh] overflow-y-auto">
              {civitaiResults.map((model) => {
                const dlState = model.filename ? downloads[model.filename] : null
                const isDl = dlState?.status === 'downloading' || dlState?.status === 'connecting'
                const isDone = dlState?.status === 'complete'

                return (
                  <div key={model.id} className="flex gap-3 p-3 rounded-lg bg-gray-50 dark:bg-white/5 border border-gray-200 dark:border-white/10">
                    {model.thumbnailUrl && (
                      <img src={proxyImageUrl(model.thumbnailUrl)} alt="" className="w-14 h-14 rounded-lg object-cover flex-shrink-0" loading="lazy" />
                    )}
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2">
                        <span className="text-sm font-medium text-gray-900 dark:text-white truncate">{model.name}</span>
                        {model.sizeGB && <span className="text-[10px] text-gray-400 flex-shrink-0">{model.sizeGB} GB</span>}
                      </div>
                      {model.description && <p className="text-[11px] text-gray-500 line-clamp-1 mt-0.5">{model.description}</p>}
                      {isDl && dlState && dlState.total > 0 && (
                        <div className="mt-1.5">
                          <ProgressBar progress={(dlState.progress / dlState.total) * 100} />
                          <span className="text-[10px] text-gray-400">{formatBytes(dlState.progress)} / {formatBytes(dlState.total)}</span>
                        </div>
                      )}
                    </div>
                    <div className="flex items-center gap-1 shrink-0">
                      {isDone ? (
                        <CheckCircle size={16} className="text-green-500" />
                      ) : isDl ? (
                        <Loader2 size={16} className="animate-spin text-gray-400" />
                      ) : model.downloadUrl ? (
                        <button onClick={() => handleCivitaiDownload(model)} className="p-2 rounded-lg bg-green-100 dark:bg-green-500/15 hover:bg-green-200 dark:hover:bg-green-500/25 text-green-700 dark:text-green-400 transition-all" title="Download" aria-label="Download">
                          <Download size={14} />
                        </button>
                      ) : null}
                      <button onClick={() => openExternal(model.sourceUrl)} className="p-2 rounded-lg hover:bg-gray-100 dark:hover:bg-white/10 text-gray-500 transition-all" title="View on CivitAI" aria-label="View on CivitAI">
                        <ExternalLink size={14} />
                      </button>
                    </div>
                  </div>
                )
              })}
            </div>
          )}

          {civitaiSearching && <div className="text-center py-4 text-gray-500 text-sm">Searching CivitAI...</div>}
          {!civitaiSearching && civitaiSearched && civitaiResults.length === 0 && (
            <div className="text-center py-4 text-[11px] text-gray-500 leading-relaxed">
              No matches for "{civitaiQuery}". Try a broader query, or add your CivitAI API key
              in the Workflow finder for the full catalog.
            </div>
          )}
        </GlassCard>
      )}

      {loading ? (
        <div className="text-center py-8 text-gray-500">Loading models...</div>
      ) : isText ? (
        <>
          {subTab === 'uncensored' && (
            <div className="grid grid-cols-1 gap-2">
              {filteredUncensored.map((model, i) => (
                <ModelDiscoverCard key={model.name} model={model} index={i} isText={isText} getModelDownloadState={getModelDownloadState} isModelFullyInstalled={isModelFullyInstalled} handleDownload={handleTextDownload} />
              ))}
              {filteredUncensored.length === 0 && (
                <p className="text-center text-gray-500 py-4 col-span-2">No uncensored models match your search</p>
              )}
            </div>
          )}
          {subTab === 'mainstream' && (
            <div className="grid grid-cols-1 gap-2">
              {filteredMainstream.map((model, i) => (
                <ModelDiscoverCard key={model.name} model={model} index={i} isText={isText} getModelDownloadState={getModelDownloadState} isModelFullyInstalled={isModelFullyInstalled} handleDownload={handleTextDownload} />
              ))}
              {filteredMainstream.length === 0 && (
                <p className="text-center text-gray-500 py-4 col-span-2">No mainstream models match your search</p>
              )}
            </div>
          )}

          {/* HuggingFace Search Results */}
          {hfSearchResults.length > 0 && (
            <div className="space-y-3 mt-6">
              <h3 className="text-[0.7rem] font-semibold text-gray-500 uppercase tracking-wider">HuggingFace Search Results</h3>
              <div className="grid grid-cols-1 gap-2">
                {hfSearchResults.map((model, i) => (
                  <ModelDiscoverCard key={model.name + i} model={model} index={i} isText={isText} getModelDownloadState={getModelDownloadState} isModelFullyInstalled={isModelFullyInstalled} handleDownload={handleTextDownload} />
                ))}
              </div>
            </div>
          )}
        </>
      ) : null}

      {!loading && filteredBundles.length === 0 && filteredUncensored.length === 0 && filteredMainstream.length === 0 && (
        <p className="text-center text-gray-500 py-4">No models found</p>
      )}

      <Modal open={!!confirmDownload} onClose={() => setConfirmDownload(null)} title="Download multi-part model">
        {confirmDownload && (
          <div className="space-y-3">
            <p className="text-[0.75rem] text-gray-700 dark:text-gray-200">
              <span className="font-semibold text-gray-900 dark:text-white">{confirmDownload.name}</span> is split into{' '}
              <span className="font-semibold text-gray-900 dark:text-white">{confirmDownload.files.length} files</span>{' '}
              totalling <span className="font-semibold text-gray-900 dark:text-white">{confirmDownload.totalGB} GB</span>.
            </p>
            <p className="text-[0.7rem] text-gray-500">
              All parts must download into one folder to load as a single model. Make sure you have the disk space — and the RAM/VRAM to actually run it.
            </p>
            {confirmDownload.totalGB > 60 && (
              <p className="text-[0.7rem] text-amber-500">
                That is very large for a local model — most consumer GPUs can't run it.
              </p>
            )}
            {confirmDownload.note && (
              <p className="text-[0.7rem] text-amber-500">{confirmDownload.note}</p>
            )}
            <div className="flex gap-2 pt-1">
              <GlowButton variant="secondary" onClick={() => setConfirmDownload(null)} className="flex-1">
                Cancel
              </GlowButton>
              <GlowButton
                onClick={() => {
                  const c = confirmDownload
                  setConfirmDownload(null)
                  startDirectDownload(c.files, c.targetDir, c.name).catch((e) => {
                    log.error('Sharded GGUF download failed', { err: e })
                    setInstallError(`Download failed: ${e instanceof Error ? e.message : String(e)}`)
                  })
                }}
                className="flex-1"
              >
                Download {confirmDownload.files.length} parts ({confirmDownload.totalGB} GB)
              </GlowButton>
            </div>
          </div>
        )}
      </Modal>
    </div>
  )
}
