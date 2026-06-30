import { useState } from 'react'
import { motion } from 'framer-motion'
import { Download, Maximize2, Copy, Check, RefreshCw, HardDrive, Brain, Cpu, Zap } from 'lucide-react'
import { getImageUrl } from '../../api/comfyui'
import { downloadComfyFile } from '../../api/backend'
import { useCreateStore, type GalleryItem } from '../../stores/createStore'
import { MediaViewer } from './MediaViewer'

export function OutputDisplay() {
  const { isGenerating, progress, progressText, progressPhase, gallery } = useCreateStore()
  const [viewerIndex, setViewerIndex] = useState<number | null>(null)
  const [copiedSeed, setCopiedSeed] = useState(false)
  // Gate the result media's fade-in on its own load so a freshly-finished
  // generation never shows a half-painted frame. Keyed by item id so it
  // auto-resets when a new result arrives.
  const [loadedId, setLoadedId] = useState<string | null>(null)
  const latest = gallery[0]

  const handleDownload = (item: GalleryItem) => {
    downloadComfyFile(item.filename, item.subfolder)
  }

  const copySeed = (seed: number) => {
    navigator.clipboard.writeText(String(seed))
    setCopiedSeed(true)
    setTimeout(() => setCopiedSeed(false), 1500)
  }

  // Phase-aware icon
  const phaseIcon = () => {
    switch (progressPhase) {
      case 'loading-model': return <HardDrive size={20} className="text-amber-400" />
      case 'loading-clip': return <Brain size={20} className="text-blue-400" />
      case 'loading-vae': return <Cpu size={20} className="text-purple-400" />
      case 'sampling': return <Zap size={20} className="text-green-400" />
      case 'decoding': return <RefreshCw size={20} className="text-cyan-400" />
      default: return null
    }
  }

  const isLoading = progressPhase === 'loading-model' || progressPhase === 'loading-clip' || progressPhase === 'loading-vae'

  // Generating state
  if (isGenerating) {
    return (
      <div className="flex-1 flex flex-col items-center justify-center p-8">
        <div className="space-y-6 flex flex-col items-center">
          {/* Phase-aware animation */}
          <div className="relative w-16 h-16">
            {isLoading ? (
              /* Slower breathing animation for model loading */
              <>
                <motion.div
                  className="absolute inset-0 rounded-full border border-amber-400/30"
                  animate={{ scale: [1, 1.6], opacity: [0.5, 0] }}
                  transition={{ duration: 3, repeat: Infinity, ease: 'easeOut' }}
                />
                <div className="absolute inset-0 rounded-full border border-amber-400/20 flex items-center justify-center">
                  <motion.div animate={{ rotate: 360 }} transition={{ duration: 3, repeat: Infinity, ease: 'linear' }}>
                    {phaseIcon()}
                  </motion.div>
                </div>
              </>
            ) : progressPhase === 'sampling' ? (
              /* Faster pulse for sampling */
              <>
                <motion.div
                  className="absolute inset-0 rounded-full border border-green-400/30"
                  animate={{ scale: [1, 1.8], opacity: [0.4, 0] }}
                  transition={{ duration: 1.2, repeat: Infinity, ease: 'easeOut' }}
                />
                <motion.div
                  className="absolute inset-0 rounded-full border border-green-400/20"
                  animate={{ scale: [1, 1.5], opacity: [0.3, 0] }}
                  transition={{ duration: 1.2, repeat: Infinity, ease: 'easeOut', delay: 0.3 }}
                />
                <div className="absolute inset-0 rounded-full border border-green-400/10 flex items-center justify-center">
                  {phaseIcon()}
                </div>
              </>
            ) : (
              /* Default pulse */
              <>
                <motion.div
                  className="absolute inset-0 rounded-full border border-gray-300 dark:border-white/20"
                  animate={{ scale: [1, 1.8], opacity: [0.4, 0] }}
                  transition={{ duration: 2, repeat: Infinity, ease: 'easeOut' }}
                />
                <motion.div
                  className="absolute inset-0 rounded-full border border-gray-300 dark:border-white/15"
                  animate={{ scale: [1, 1.5], opacity: [0.3, 0] }}
                  transition={{ duration: 2, repeat: Infinity, ease: 'easeOut', delay: 0.5 }}
                />
                <div className="absolute inset-0 rounded-full border border-gray-200 dark:border-white/10 flex items-center justify-center">
                  <motion.div
                    className="w-2 h-2 rounded-full bg-gray-400 dark:bg-white/40"
                    animate={{ opacity: [0.3, 0.8, 0.3] }}
                    transition={{ duration: 1.5, repeat: Infinity }}
                  />
                </div>
              </>
            )}
          </div>
          <p className="text-gray-500 text-xs tracking-wide">{progressText || 'Generating...'}</p>
          {/* Progress bar — shown for the whole run (loading → sampling →
              decoding). Steps live in progressText above. No time estimates. */}
          {progress > 0 && (
            <div className="w-56 h-1 bg-gray-200 dark:bg-white/10 rounded-full overflow-hidden">
              <motion.div
                className="h-full rounded-full bg-[rgb(160,148,248)]"
                initial={{ width: 0 }}
                animate={{ width: `${Math.min(progress, 100)}%` }}
                transition={{ duration: 0.3 }}
              />
            </div>
          )}
        </div>
      </div>
    )
  }

  // Empty state
  if (!latest) {
    return (
      <div className="flex-1 flex items-center justify-center p-8">
        <div className="text-center space-y-3">
          <div className="w-12 h-12 mx-auto rounded-full border border-gray-200 dark:border-white/10 flex items-center justify-center">
            <div className="w-1.5 h-1.5 rounded-full bg-gray-300 dark:bg-white/20" />
          </div>
          <p className="text-gray-400 dark:text-gray-500 text-sm">Your creations will appear here</p>
          <p className="text-gray-300 dark:text-gray-600 text-xs">Write a prompt and hit Generate</p>
        </div>
      </div>
    )
  }

  // Show latest result — stable URL (item's createdAt as cache token) so the
  // element never refetches across re-renders.
  const url = getImageUrl(latest.filename, latest.subfolder, 'output', latest.createdAt)
  const ready = loadedId === latest.id

  return (
    <>
      <div className="flex-1 flex flex-col items-center justify-center p-4 relative group min-h-0 overflow-hidden">
        <motion.div
          initial={{ opacity: 0, scale: 0.95 }}
          animate={{ opacity: 1, scale: 1 }}
          className="relative flex flex-col items-center min-h-0 max-h-full max-w-full"
        >
          {latest.type === 'video' ? (
            <video
              key={latest.id}
              src={url}
              controls
              autoPlay
              loop
              playsInline
              onLoadedData={() => setLoadedId(latest.id)}
              className="max-w-full max-h-full rounded-xl border border-gray-200 dark:border-white/10 object-contain cursor-pointer bg-black"
              style={{ opacity: ready ? 1 : 0, transition: 'opacity 0.25s ease-out' }}
              onClick={() => setViewerIndex(0)}
            />
          ) : (
            <img
              key={latest.id}
              src={url}
              alt={latest.prompt}
              onLoad={() => setLoadedId(latest.id)}
              className="max-w-full max-h-full rounded-xl border border-gray-200 dark:border-white/10 object-contain cursor-pointer"
              style={{ opacity: ready ? 1 : 0, transition: 'opacity 0.25s ease-out' }}
              onClick={() => setViewerIndex(0)}
            />
          )}

          {/* Hover controls */}
          <div className="absolute top-2 right-2 flex gap-1 opacity-0 group-hover:opacity-100 transition-opacity z-10">
            <button
              onClick={() => setViewerIndex(0)}
              className="p-2 rounded-lg bg-black/50 text-white hover:bg-black/70 transition-colors"
              title="Fullscreen"
            >
              <Maximize2 size={14} />
            </button>
            <button
              onClick={() => handleDownload(latest)}
              className="p-2 rounded-lg bg-black/50 text-white hover:bg-black/70 transition-colors"
              title="Download"
            >
              <Download size={14} />
            </button>
          </div>
        </motion.div>

        {/* Info bar */}
        <div className="flex items-center gap-3 mt-2 text-xs text-gray-400">
          <span className="truncate max-w-xs">{latest.prompt}</span>
          <span>·</span>
          <button
            onClick={() => copySeed(latest.seed)}
            className="flex items-center gap-1 hover:text-gray-600 dark:hover:text-gray-300 transition-colors"
            title="Copy seed"
          >
            Seed: {latest.seed} {copiedSeed ? <Check size={10} /> : <Copy size={10} />}
          </button>
          <span>·</span>
          <span>{latest.width}x{latest.height}</span>
        </div>
      </div>

      {/* Media Viewer */}
      {viewerIndex !== null && (
        <MediaViewer
          gallery={gallery}
          initialIndex={viewerIndex}
          onClose={() => setViewerIndex(null)}
        />
      )}
    </>
  )
}
