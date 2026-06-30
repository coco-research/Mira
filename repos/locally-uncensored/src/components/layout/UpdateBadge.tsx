import { useState, useRef, useEffect } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import { ArrowUpCircle, Download, RefreshCw, RotateCcw, X, Loader2 } from 'lucide-react'
import { useUpdateStore, initUpdateChecker } from '../../stores/updateStore'
import { formatBytes } from '../../lib/formatters'
import { isTauri } from '../../api/backend'

export function UpdateBadge() {
  const {
    currentVersion,
    latestVersion,
    updateAvailable,
    releaseNotes,
    dismissed,
    downloadStatus,
    downloadProgress,
    downloadedBytes,
    totalBytes,
    errorMessage,
    downloadUpdate,
    installAndRestart,
    dismissUpdate,
  } = useUpdateStore()

  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => { initUpdateChecker() }, [])

  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [])

  const showBadge = updateAvailable && latestVersion && dismissed !== latestVersion
  if (!showBadge) return null

  const isDownloading = downloadStatus === 'downloading'
  const isDownloaded = downloadStatus === 'downloaded'
  const isInstalling = downloadStatus === 'installing'
  const isError = downloadStatus === 'error'
  const canDownload = isTauri() && downloadStatus === 'idle'

  return (
    <div ref={ref} className="relative">
      {/* Badge button */}
      <button
        onClick={() => setOpen(!open)}
        className={`relative p-1 rounded-md transition-colors ${
          isDownloaded
            ? 'text-emerald-400 hover:bg-emerald-500/10'
            : isDownloading
              ? 'text-blue-400 hover:bg-blue-500/10'
              : isError
                ? 'text-red-400 hover:bg-red-500/10'
                : 'text-emerald-400 hover:bg-emerald-500/10'
        }`}
        title={
          isDownloaded ? 'Update ready — click to restart'
            : isDownloading ? `Downloading update... ${downloadProgress}%`
              : `Update available: v${latestVersion}`
        }
      >
        {isDownloading ? (
          <Loader2 size={20} strokeWidth={1.8} className="animate-spin" />
        ) : (
          <ArrowUpCircle size={20} strokeWidth={1.8} />
        )}
        {/* Status dot */}
        <span className={`absolute top-0 right-0 w-2.5 h-2.5 rounded-full ${
          isDownloaded ? 'bg-emerald-400'
            : isDownloading ? 'bg-blue-400'
              : isError ? 'bg-red-400'
                : 'bg-emerald-400'
        }`}>
          {!isDownloaded && !isError && (
            <span className={`absolute inset-0 rounded-full animate-ping opacity-75 ${
              isDownloading ? 'bg-blue-400' : 'bg-emerald-400'
            }`} />
          )}
        </span>
      </button>

      {/* Dropdown */}
      <AnimatePresence>
        {open && (
          <motion.div
            className="absolute right-0 top-full mt-1.5 w-72 rounded-lg overflow-hidden z-50 bg-[#363636] border border-white/[0.08] shadow-2xl shadow-black/50"
            initial={{ opacity: 0, y: -6, scale: 0.98 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: -6, scale: 0.98 }}
            transition={{ duration: 0.12, ease: 'easeOut' }}
          >
            {/* Header */}
            <div className="flex items-center justify-between px-3 pt-3 pb-1">
              <span className={`text-[0.65rem] font-semibold uppercase tracking-widest ${
                isDownloaded ? 'text-emerald-400/70'
                  : isDownloading ? 'text-blue-400/70'
                    : isError ? 'text-red-400/70'
                      : 'text-emerald-400/70'
              }`}>
                {isDownloaded ? 'Ready to Install'
                  : isDownloading ? 'Downloading Update'
                    : isInstalling ? 'Installing...'
                      : isError ? 'Update Error'
                        : 'Update Available'}
              </span>
              {!isDownloading && !isInstalling && (
                <button
                  onClick={(e) => { e.stopPropagation(); dismissUpdate(); setOpen(false) }}
                  className="p-0.5 rounded text-gray-600 hover:text-gray-300 transition-colors"
                  title="Dismiss"
                >
                  <X size={12} />
                </button>
              )}
            </div>

            {/* Version info */}
            <div className="px-3 py-2">
              <div className="flex items-center gap-2 text-[0.7rem]">
                <span className="text-gray-500">v{currentVersion}</span>
                <span className="text-gray-600">&rarr;</span>
                <span className="text-emerald-400 font-medium">v{latestVersion}</span>
              </div>
            </div>

            {/* Download progress */}
            {(isDownloading || isDownloaded) && (
              <div className="px-3 pb-2">
                <div className="w-full h-1 rounded-full bg-white/[0.06] overflow-hidden">
                  <motion.div
                    className={`h-full rounded-full ${isDownloaded ? 'bg-emerald-500' : 'bg-blue-500'}`}
                    initial={{ width: 0 }}
                    animate={{ width: `${downloadProgress}%` }}
                    transition={{ duration: 0.3 }}
                  />
                </div>
                <div className="flex items-center justify-between mt-1">
                  <span className="text-[0.55rem] text-gray-500">
                    {isDownloaded ? 'Download complete' : `${downloadProgress}%`}
                  </span>
                  {totalBytes > 0 && (
                    <span className="text-[0.55rem] text-gray-600">
                      {formatBytes(downloadedBytes)} / {formatBytes(totalBytes)}
                    </span>
                  )}
                </div>
              </div>
            )}

            {/* Error message */}
            {isError && errorMessage && (
              <div className="px-3 pb-2">
                <p className="text-[0.6rem] text-red-400/80 leading-relaxed">{errorMessage}</p>
              </div>
            )}

            {/* Release notes */}
            {releaseNotes && !isDownloading && !isDownloaded && (
              <div className="px-3 pb-2">
                <p className="text-[0.6rem] text-gray-500 leading-relaxed line-clamp-4 whitespace-pre-line">
                  {releaseNotes}
                </p>
              </div>
            )}

            {/* Actions */}
            <div className="border-t border-white/[0.04] p-2 flex gap-1.5">
              {/* State: idle — show Download button */}
              {canDownload && (
                <>
                  <button
                    onClick={() => downloadUpdate()}
                    className="flex-1 flex items-center justify-center gap-1.5 px-2 py-1.5 rounded-md text-[0.65rem] font-medium bg-emerald-500/15 text-emerald-400 hover:bg-emerald-500/25 transition-colors"
                  >
                    <Download size={11} />
                    Download Update
                  </button>
                  <button
                    onClick={() => { dismissUpdate(); setOpen(false) }}
                    className="px-2 py-1.5 rounded-md text-[0.65rem] text-gray-500 hover:text-gray-300 hover:bg-white/[0.04] transition-colors"
                  >
                    Later
                  </button>
                </>
              )}

              {/* State: downloading — show progress info */}
              {isDownloading && (
                <div className="flex-1 text-center text-[0.6rem] text-blue-400/70 py-1">
                  Downloading...
                </div>
              )}

              {/* State: downloaded — Restart + Later */}
              {isDownloaded && (
                <>
                  <button
                    onClick={() => installAndRestart()}
                    className="flex-1 flex items-center justify-center gap-1.5 px-2 py-1.5 rounded-md text-[0.65rem] font-medium bg-emerald-500/15 text-emerald-400 hover:bg-emerald-500/25 transition-colors"
                  >
                    <RefreshCw size={11} />
                    Restart Now
                  </button>
                  <button
                    onClick={() => { setOpen(false) }}
                    className="px-2 py-1.5 rounded-md text-[0.65rem] text-gray-500 hover:text-gray-300 hover:bg-white/[0.04] transition-colors"
                  >
                    Later
                  </button>
                </>
              )}

              {/* State: installing */}
              {isInstalling && (
                <div className="flex-1 flex items-center justify-center gap-1.5 text-[0.6rem] text-emerald-400/70 py-1">
                  <Loader2 size={11} className="animate-spin" />
                  Installing...
                </div>
              )}

              {/* State: error — Retry */}
              {isError && (
                <>
                  <button
                    onClick={() => downloadUpdate()}
                    className="flex-1 flex items-center justify-center gap-1.5 px-2 py-1.5 rounded-md text-[0.65rem] font-medium bg-red-500/15 text-red-400 hover:bg-red-500/25 transition-colors"
                  >
                    <RotateCcw size={11} />
                    Retry
                  </button>
                  <button
                    onClick={() => { dismissUpdate(); setOpen(false) }}
                    className="px-2 py-1.5 rounded-md text-[0.65rem] text-gray-500 hover:text-gray-300 hover:bg-white/[0.04] transition-colors"
                  >
                    Dismiss
                  </button>
                </>
              )}

              {/* Dev mode: no in-app install, link to GitHub */}
              {!isTauri() && downloadStatus === 'idle' && (
                <>
                  <button
                    onClick={() => {
                      window.open(`https://github.com/purpledoubled/locally-uncensored/releases/latest`, '_blank')
                      setOpen(false)
                    }}
                    className="flex-1 flex items-center justify-center gap-1.5 px-2 py-1.5 rounded-md text-[0.65rem] font-medium bg-emerald-500/15 text-emerald-400 hover:bg-emerald-500/25 transition-colors"
                  >
                    <Download size={11} />
                    View Release
                  </button>
                  <button
                    onClick={() => { dismissUpdate(); setOpen(false) }}
                    className="px-2 py-1.5 rounded-md text-[0.65rem] text-gray-500 hover:text-gray-300 hover:bg-white/[0.04] transition-colors"
                  >
                    Later
                  </button>
                </>
              )}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  )
}
