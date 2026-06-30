import { useState, useEffect, useRef, useCallback } from 'react'
import { createPortal } from 'react-dom'
import { motion, AnimatePresence } from 'framer-motion'
import { X, Download, ChevronLeft, ChevronRight, ZoomIn, ZoomOut, Info } from 'lucide-react'
import { getImageUrl } from '../../api/comfyui'
import { downloadComfyFile } from '../../api/backend'
import type { GalleryItem } from '../../stores/createStore'

interface Props {
  gallery: GalleryItem[]
  initialIndex: number
  onClose: () => void
}

const MIN_ZOOM = 1
const MAX_ZOOM = 5

// Small round icon button used across the viewer chrome.
function IconBtn({
  children, title, onClick, active = false,
}: { children: React.ReactNode; title: string; onClick: () => void; active?: boolean }) {
  return (
    <button
      onClick={onClick}
      title={title}
      aria-label={title}
      className={`p-2 rounded-full backdrop-blur transition-colors ${
        active
          ? 'bg-[rgba(160,148,248,0.28)] text-white ring-1 ring-[rgba(160,148,248,0.5)]'
          : 'bg-white/10 text-white/90 hover:bg-white/20'
      }`}
    >
      {children}
    </button>
  )
}

function NavBtn({ side, onClick }: { side: 'left' | 'right'; onClick: () => void }) {
  return (
    <button
      onClick={(e) => { e.stopPropagation(); onClick() }}
      aria-label={side === 'left' ? 'Previous' : 'Next'}
      className={`absolute ${side === 'left' ? 'left-3' : 'right-3'} top-1/2 -translate-y-1/2 z-20 p-3 rounded-full bg-black/40 text-white/90 hover:bg-black/70 backdrop-blur transition-colors`}
    >
      {side === 'left' ? <ChevronLeft size={24} /> : <ChevronRight size={24} />}
    </button>
  )
}

function Meta({ k, v, wide = false }: { k: string; v: string; wide?: boolean }) {
  return (
    <span className={wide ? 'w-full sm:w-auto sm:max-w-[40ch] truncate' : ''}>
      <b className="text-white/80 font-medium">{k}:</b> {v}
    </span>
  )
}

export function MediaViewer({ gallery, initialIndex, onClose }: Props) {
  const [index, setIndex] = useState(initialIndex)
  const [zoom, setZoom] = useState(1)
  const [pan, setPan] = useState({ x: 0, y: 0 })
  const [dragging, setDragging] = useState(false)
  const [showInfo, setShowInfo] = useState(false)
  const [closing, setClosing] = useState(false)
  // The URL whose media has finished loading. `ready` compares it to the
  // current url synchronously, so a freshly-navigated item is at opacity 0
  // from its very first render until it decodes (no flash of an empty frame).
  const [loadedUrl, setLoadedUrl] = useState('')
  const dragStart = useRef({ x: 0, y: 0 })
  const panStart = useRef({ x: 0, y: 0 })
  const stageRef = useRef<HTMLDivElement>(null)

  // Clamp so a deleted item (gallery shrank under us) never indexes out of range.
  const safeIndex = Math.max(0, Math.min(index, gallery.length - 1))
  const item = gallery[safeIndex] as GalleryItem | undefined
  const isVideo = item?.type === 'video'

  // Stable URL: keyed on the item's immutable createdAt, so the string is
  // identical across every re-render (zoom/pan/mouse-move) → no refetch, no
  // flicker. Empty when the gallery has emptied out.
  const url = item ? getImageUrl(item.filename, item.subfolder, 'output', item.createdAt) : ''
  const ready = !!url && loadedUrl === url

  const resetView = useCallback(() => { setZoom(1); setPan({ x: 0, y: 0 }) }, [])

  // Fade out first, then unmount via onClose (gives a smooth close without
  // relying on a parent <AnimatePresence>, which the old code mis-used).
  const requestClose = useCallback(() => setClosing(true), [])

  const navigate = useCallback((dir: 1 | -1) => {
    setIndex((i) => {
      const next = i + dir
      if (next < 0 || next > gallery.length - 1) return i
      return next
    })
    resetView()
  }, [gallery.length, resetView])

  // If the gallery empties while open, close cleanly.
  useEffect(() => { if (!item && !closing) requestClose() }, [item, closing, requestClose])

  // Keyboard navigation + zoom.
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      switch (e.key) {
        case 'Escape': requestClose(); break
        case 'ArrowLeft': navigate(-1); break
        case 'ArrowRight': navigate(1); break
        case '+': case '=': setZoom((z) => Math.min(z + 0.5, MAX_ZOOM)); break
        case '-': case '_':
          setZoom((z) => {
            const n = Math.max(z - 0.5, MIN_ZOOM)
            if (n <= 1) setPan({ x: 0, y: 0 })
            return n
          })
          break
        case '0': resetView(); break
      }
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [navigate, requestClose, resetView])

  // Wheel zoom via a non-passive native listener so preventDefault actually
  // works (React's synthetic onWheel is passive → preventDefault is a no-op +
  // console error). The overlay is fixed full-screen, so we suppress the
  // underlying scroll entirely.
  useEffect(() => {
    const el = stageRef.current
    if (!el) return
    const onWheel = (e: WheelEvent) => {
      e.preventDefault()
      const delta = e.deltaY > 0 ? -0.25 : 0.25
      setZoom((z) => {
        const n = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, z + delta))
        if (n <= 1) setPan({ x: 0, y: 0 })
        return n
      })
    }
    el.addEventListener('wheel', onWheel, { passive: false })
    return () => el.removeEventListener('wheel', onWheel)
  }, [])

  // Pan (only meaningful while zoomed in).
  const onMouseDown = (e: React.MouseEvent) => {
    if (zoom <= 1) return
    e.preventDefault()
    setDragging(true)
    dragStart.current = { x: e.clientX, y: e.clientY }
    panStart.current = { ...pan }
  }
  const onMouseMove = (e: React.MouseEvent) => {
    if (!dragging) return
    setPan({
      x: panStart.current.x + (e.clientX - dragStart.current.x),
      y: panStart.current.y + (e.clientY - dragStart.current.y),
    })
  }
  const endDrag = () => setDragging(false)

  const content = (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: closing ? 0 : 1 }}
      transition={{ duration: 0.18, ease: 'easeOut' }}
      onAnimationComplete={() => { if (closing) onClose() }}
      className="fixed inset-0 z-[100] flex flex-col bg-[#0b0b0e]/95 backdrop-blur-md"
      onMouseMove={onMouseMove}
      onMouseUp={endDrag}
      onMouseLeave={endDrag}
    >
      {/* Top scrim keeps the controls readable over bright images. */}
      <div className="absolute inset-x-0 top-0 h-24 bg-gradient-to-b from-black/55 to-transparent pointer-events-none z-10" />

      {/* Top bar */}
      <div className="relative flex items-center justify-between px-4 py-3 z-20">
        <div className="flex items-center gap-2 text-white/70 text-xs">
          <span className="tabular-nums">{safeIndex + 1} / {gallery.length}</span>
          {isVideo && (
            <span className="px-1.5 py-0.5 rounded bg-white/10 text-[10px] uppercase tracking-wider text-white/60">Video</span>
          )}
        </div>
        <div className="flex items-center gap-1.5">
          {!isVideo && (
            <>
              <IconBtn title="Zoom out (−)" onClick={() => setZoom((z) => {
                const n = Math.max(MIN_ZOOM, z - 0.5)
                if (n <= 1) setPan({ x: 0, y: 0 })
                return n
              })}>
                <ZoomOut size={17} />
              </IconBtn>
              <span className="text-white/55 text-xs w-11 text-center tabular-nums">{Math.round(zoom * 100)}%</span>
              <IconBtn title="Zoom in (+)" onClick={() => setZoom((z) => Math.min(MAX_ZOOM, z + 0.5))}>
                <ZoomIn size={17} />
              </IconBtn>
              <div className="w-px h-5 bg-white/15 mx-1" />
            </>
          )}
          <IconBtn title="Info" active={showInfo} onClick={() => setShowInfo((s) => !s)}>
            <Info size={17} />
          </IconBtn>
          <IconBtn title="Download" onClick={() => item && downloadComfyFile(item.filename, item.subfolder)}>
            <Download size={17} />
          </IconBtn>
          <IconBtn title="Close (Esc)" onClick={requestClose}>
            <X size={17} />
          </IconBtn>
        </div>
      </div>

      {/* Stage */}
      <div
        ref={stageRef}
        className="flex-1 flex items-center justify-center overflow-hidden relative select-none"
        onClick={(e) => { if (e.target === e.currentTarget) requestClose() }}
      >
        {safeIndex > 0 && <NavBtn side="left" onClick={() => navigate(-1)} />}
        {safeIndex < gallery.length - 1 && <NavBtn side="right" onClick={() => navigate(1)} />}

        {item && (isVideo ? (
          <video
            key={item.id}
            src={url}
            controls
            autoPlay
            loop
            playsInline
            className="max-w-[92vw] max-h-[82vh] rounded-lg shadow-2xl bg-black"
            onLoadedData={() => setLoadedUrl(url)}
            onClick={(e) => e.stopPropagation()}
            style={{ opacity: ready ? 1 : 0, transition: 'opacity 0.2s ease-out' }}
          />
        ) : (
          <img
            key={item.id}
            src={url}
            alt={item.prompt}
            onLoad={() => setLoadedUrl(url)}
            draggable={false}
            onMouseDown={onMouseDown}
            className="max-w-[92vw] max-h-[82vh] object-contain rounded-lg shadow-2xl"
            style={{
              transform: `scale(${zoom}) translate(${pan.x / zoom}px, ${pan.y / zoom}px)`,
              transition: dragging ? 'none' : 'transform 0.16s ease-out, opacity 0.2s ease-out',
              opacity: ready ? 1 : 0,
              cursor: zoom > 1 ? (dragging ? 'grabbing' : 'grab') : 'default',
            }}
          />
        ))}
      </div>

      {/* Info panel */}
      <AnimatePresence>
        {showInfo && item && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.18 }}
            className="relative z-20 overflow-hidden border-t border-white/10 bg-black/40 backdrop-blur"
          >
            <div className="px-6 py-3 flex flex-wrap gap-x-6 gap-y-1.5 text-xs text-white/55">
              <Meta k="Prompt" v={item.prompt} wide />
              {item.negativePrompt && <Meta k="Negative" v={item.negativePrompt} wide />}
              <Meta k="Model" v={item.model} />
              <Meta k="Size" v={`${item.width}×${item.height}`} />
              <Meta k="Steps" v={String(item.steps)} />
              <Meta k="CFG" v={String(item.cfgScale)} />
              <Meta k="Sampler" v={`${item.sampler}/${item.scheduler}`} />
              <Meta k="Seed" v={String(item.seed)} />
              {item.builderUsed && <Meta k="Builder" v={item.builderUsed} />}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </motion.div>
  )

  // Render into <body> so no ancestor transform/zoom/overflow (e.g. the +25%
  // sidebar zoom, or a framer-motion scale animation) can break the fixed
  // overlay's sizing/position.
  return createPortal(content, document.body)
}
