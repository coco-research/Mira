import { useEffect, useMemo, useRef, useState } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import { X, ExternalLink, Smartphone, Tablet, Monitor, RotateCw } from 'lucide-react'
import { openExternal } from '../../api/backend'

interface Props {
  code: string
  language?: string
  onClose: () => void
}

type Viewport = 'mobile' | 'tablet' | 'desktop'

const VIEWPORTS: Record<Viewport, { width: number; height: number }> = {
  mobile: { width: 375, height: 667 },
  tablet: { width: 768, height: 1024 },
  desktop: { width: 1280, height: 800 },
}

/**
 * Wrap an HTML / SVG snippet so the iframe always has a sane shell.
 *   - Bare SVG → centred dark page that hugs the artwork.
 *   - Snippet HTML (no <html>/<doctype>) → minimal doc with utf-8 + body padding.
 *   - Full document → passed through untouched.
 *
 * The iframe runs with `sandbox="allow-scripts"` (no allow-same-origin), so
 * any user JS lives in an opaque origin and can't reach our app.
 */
function buildDocument(code: string, language?: string): string {
  const lang = (language || '').toLowerCase()
  const trimmed = code.trim()
  const lower = trimmed.toLowerCase()

  // Bare SVG.
  if (lang === 'svg' || (lower.startsWith('<svg') && lower.includes('xmlns'))) {
    return [
      '<!doctype html><html><head><meta charset="utf-8"><title>SVG Preview</title>',
      '<style>html,body{margin:0;padding:0;background:#0e0e0e;color:#fff;height:100%;display:flex;align-items:center;justify-content:center;font-family:system-ui,sans-serif}svg{max-width:100%;max-height:100%}</style>',
      '</head><body>',
      code,
      '</body></html>',
    ].join('')
  }

  // Already a full document.
  if (lower.startsWith('<!doctype') || lower.startsWith('<html')) {
    return code
  }

  // Snippet — wrap.
  return [
    '<!doctype html><html><head><meta charset="utf-8"><title>HTML Preview</title>',
    '<style>body{margin:0;padding:16px;font-family:system-ui,-apple-system,"Segoe UI",sans-serif;line-height:1.5;background:#ffffff;color:#111}</style>',
    '</head><body>',
    code,
    '</body></html>',
  ].join('')
}

export function HtmlPreviewModal({ code, language, onClose }: Props) {
  const [viewport, setViewport] = useState<Viewport>('desktop')
  const [reloadKey, setReloadKey] = useState(0)
  const iframeRef = useRef<HTMLIFrameElement>(null)
  const doc = useMemo(() => buildDocument(code, language), [code, language])

  // Esc closes — matches every other overlay in the app.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  const dims = VIEWPORTS[viewport]

  const openInBrowser = () => {
    // Hand the data URL to the host browser. data: URLs work in modern
    // browsers; users can then save / share / inspect with full devtools.
    const dataUrl = `data:text/html;charset=utf-8;base64,${btoa(unescape(encodeURIComponent(doc)))}`
    openExternal(dataUrl)
  }

  return (
    <AnimatePresence>
      <motion.div
        className="fixed inset-0 z-[200] flex items-center justify-center bg-black/70 backdrop-blur-sm p-4"
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        exit={{ opacity: 0 }}
        transition={{ duration: 0.15 }}
        onClick={(e) => { if (e.target === e.currentTarget) onClose() }}
      >
        <motion.div
          className="bg-white dark:bg-gray-900 border border-gray-200 dark:border-white/10 rounded-lg shadow-2xl flex flex-col overflow-hidden w-full max-w-[95vw] h-[90vh] max-h-[900px]"
          initial={{ scale: 0.96, opacity: 0 }}
          animate={{ scale: 1, opacity: 1 }}
          exit={{ scale: 0.96, opacity: 0 }}
          transition={{ duration: 0.15 }}
        >
          {/* Header */}
          <div className="flex items-center justify-between gap-3 px-4 py-2.5 border-b border-gray-200 dark:border-white/10 bg-gray-50 dark:bg-white/[0.02]">
            <div className="flex items-center gap-2">
              <span className="text-xs font-semibold tracking-wider uppercase text-gray-500 dark:text-gray-400">
                HTML Preview
              </span>
              <span className="text-[0.6rem] text-gray-400 dark:text-gray-500 font-mono">
                {language || 'html'}
              </span>
            </div>

            {/* Viewport switcher */}
            <div className="flex items-center gap-0.5 bg-gray-100 dark:bg-white/[0.04] rounded-md p-0.5">
              <ViewportBtn icon={Smartphone} active={viewport === 'mobile'}  onClick={() => setViewport('mobile')}  label="Mobile" />
              <ViewportBtn icon={Tablet}     active={viewport === 'tablet'}  onClick={() => setViewport('tablet')}  label="Tablet" />
              <ViewportBtn icon={Monitor}    active={viewport === 'desktop'} onClick={() => setViewport('desktop')} label="Desktop" />
            </div>

            <div className="flex items-center gap-1">
              <button
                onClick={() => setReloadKey((k) => k + 1)}
                className="p-1.5 rounded-md text-gray-500 dark:text-gray-400 hover:bg-gray-200 dark:hover:bg-white/[0.06] hover:text-gray-700 dark:hover:text-white transition-colors"
                aria-label="Reload preview"
                title="Reload preview"
              >
                <RotateCw size={14} />
              </button>
              <button
                onClick={openInBrowser}
                className="p-1.5 rounded-md text-gray-500 dark:text-gray-400 hover:bg-gray-200 dark:hover:bg-white/[0.06] hover:text-gray-700 dark:hover:text-white transition-colors"
                aria-label="Open in browser"
                title="Open in browser"
              >
                <ExternalLink size={14} />
              </button>
              <button
                onClick={onClose}
                className="p-1.5 rounded-md text-gray-500 dark:text-gray-400 hover:bg-gray-200 dark:hover:bg-white/[0.06] hover:text-gray-700 dark:hover:text-white transition-colors"
                aria-label="Close"
                title="Close (Esc)"
              >
                <X size={14} />
              </button>
            </div>
          </div>

          {/* Frame area — checkered background to make the rendered surface obvious */}
          <div className="flex-1 overflow-auto bg-[length:24px_24px] bg-[linear-gradient(45deg,rgba(0,0,0,0.04)_25%,transparent_25%,transparent_75%,rgba(0,0,0,0.04)_75%),linear-gradient(45deg,rgba(0,0,0,0.04)_25%,transparent_25%,transparent_75%,rgba(0,0,0,0.04)_75%)] bg-[position:0_0,12px_12px] dark:bg-[length:24px_24px] dark:bg-[linear-gradient(45deg,rgba(255,255,255,0.03)_25%,transparent_25%,transparent_75%,rgba(255,255,255,0.03)_75%),linear-gradient(45deg,rgba(255,255,255,0.03)_25%,transparent_25%,transparent_75%,rgba(255,255,255,0.03)_75%)] flex items-center justify-center p-4">
            <iframe
              key={reloadKey}
              ref={iframeRef}
              srcDoc={doc}
              sandbox="allow-scripts"
              referrerPolicy="no-referrer"
              title="HTML Preview"
              className="bg-white border border-gray-200 dark:border-white/10 shadow-lg rounded transition-all"
              style={{
                width: viewport === 'desktop' ? '100%' : `${dims.width}px`,
                height: viewport === 'desktop' ? '100%' : `${dims.height}px`,
                maxWidth: '100%',
                maxHeight: '100%',
              }}
            />
          </div>
        </motion.div>
      </motion.div>
    </AnimatePresence>
  )
}

interface ViewportBtnProps {
  icon: typeof Smartphone
  active: boolean
  onClick: () => void
  label: string
}
function ViewportBtn({ icon: Icon, active, onClick, label }: ViewportBtnProps) {
  return (
    <button
      onClick={onClick}
      className={
        'flex items-center justify-center w-7 h-7 rounded transition-colors ' +
        (active
          ? 'bg-white dark:bg-white/10 text-gray-900 dark:text-white shadow-sm'
          : 'text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-white')
      }
      aria-label={label}
      title={label}
    >
      <Icon size={13} />
    </button>
  )
}
