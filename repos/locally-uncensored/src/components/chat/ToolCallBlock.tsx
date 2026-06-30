import { useState } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import { Search, Globe, FileText, FileEdit, Terminal, Image, Film, Loader2, Check, X, Clock, AlertCircle, FolderOpen, Cpu, Monitor, GitBranch, Database, Download } from 'lucide-react'
import type { AgentToolCall } from '../../types/agent-mode'
import { getComfyHost, getComfyPort, downloadComfyFile } from '../../api/backend'
import { useModelPickStore } from '../../stores/modelPickStore'
import { ModelPickerCard, ChangeModelInline, pickKindForToolCall } from './ModelPickerCard'

// F1 (konata3602 commitment 2026-05-23) + render fix (konata3602 bug 2026-06-07)
// — when image_generate / video_generate / screenshot produce a ComfyUI output,
// the user must SEE the picture, not a path string. The tool result embeds a
// ComfyUI /view URL whose exact form depends on the runtime:
//   - packaged desktop (Tauri):     http://localhost:8188/view?filename=…
//   - custom / remote ComfyUI host: http://<host>:<port>/view?filename=…
//   - browser / dev (Vite proxy):   /comfyui/view?filename=…   ← konata's case
// The original localhost-only regex silently failed on the latter two, so
// konata (running the web build behind the /comfyui proxy) saw the raw
// "/comfyui/view?…" text and NO image. comfyViewUrlFromResult() now accepts any
// of those forms, but ONLY when the URL points at OUR ComfyUI — a relative
// proxy path, a loopback host, or the user-configured comfy host — and carries
// a filename. A third-party URL in a tool result is never auto-loaded (CSP +
// privacy). Exported for unit testing (see __tests__/ToolCallBlock-image.test.ts).
export function comfyViewUrlFromResult(result: string | null | undefined): string | null {
  if (!result) return null
  const m = result.match(/(https?:\/\/[^\s)\]]+\/view\?[^\s)\]]+|\/comfyui\/view\?[^\s)\]]+|\/view\?[^\s)\]]+)/i)
  if (!m) return null
  const url = m[1]
  if (!/[?&]filename=/i.test(url)) return null               // must be a real ComfyUI output view
  if (url.startsWith('/comfyui/view') || url.startsWith('/view?')) return url   // our own proxy path — safe
  try {
    const host = new URL(url).hostname.toLowerCase()
    const loopback = host === 'localhost' || host === '127.0.0.1' || host === '::1' || host === '0.0.0.0'
    if (loopback || host === getComfyHost().toLowerCase()) return url
  } catch { /* not a parseable absolute URL — fall through to null */ }
  return null
}

// Feature EE (v2.5.0): video_generate can produce .mp4 (VHS_VideoCombine) or
// .webm outputs. We render those in a <video> element instead of an <img>.
// Animated .webp (SaveAnimatedWEBP) animates fine inside <img>, so it stays on
// the image path. The output filename rides in the `filename=` query param of
// the /view URL, so we inspect THAT, not the URL tail (which ends in `&t=…`).
// Exported for unit testing.
export function isInlineVideoUrl(url: string): boolean {
  try {
    const m = /[?&]filename=([^&]+)/i.exec(url)
    const name = m ? decodeURIComponent(m[1]) : url
    return /\.(mp4|webm)$/i.test(name)
  } catch {
    return /\.(mp4|webm)(?=[?&]|$)/i.test(url)
  }
}

// David 2026-06-12 ("alle tools in chat, mit download"): pull the ComfyUI
// filename/subfolder/type back out of a /view URL so the inline image/video
// gets a Download button (downloadComfyFile fetches the real bytes → native
// Save-As in Tauri / anchor download in the browser). Returns null if the URL
// has no filename. Exported for unit testing.
export function comfyViewParams(url: string | null | undefined): { filename: string; subfolder: string; type: string } | null {
  if (!url) return null
  try {
    const q = url.includes('?') ? url.slice(url.indexOf('?') + 1) : ''
    const p = new URLSearchParams(q)
    const filename = p.get('filename')
    if (!filename) return null
    return { filename, subfolder: p.get('subfolder') || '', type: p.get('type') || 'output' }
  } catch {
    return null
  }
}

interface Props {
  toolCall: AgentToolCall
  onApprove?: () => void
  onReject?: () => void
}

const TOOL_ICONS: Record<string, typeof Search> = {
  web_search: Search,
  web_fetch: Globe,
  file_read: FileText,
  file_write: FileEdit,
  file_list: FolderOpen,
  file_search: Search,
  code_execute: Terminal,
  shell_execute: Terminal,
  system_info: Cpu,
  process_list: Cpu,
  screenshot: Monitor,
  image_generate: Image,
  video_generate: Film,
  run_workflow: GitBranch,
}

const STATUS_ICONS = {
  pending_approval: Clock,
  running: Loader2,
  completed: Check,
  failed: AlertCircle,
  rejected: X,
  // Phase 6 (v2.4.0): cached result from in-turn cache, no re-execution.
  cached: Database,
}

export function ToolCallBlock({ toolCall, onApprove, onReject }: Props) {
  // Default: collapsed (closed)
  const [open, setOpen] = useState(toolCall.status === 'pending_approval')

  const ToolIcon = TOOL_ICONS[toolCall.toolName] || Terminal
  const StatusIcon = STATUS_ICONS[toolCall.status]
  const isRunning = toolCall.status === 'running'
  const isPending = toolCall.status === 'pending_approval'
  const isFailed = toolCall.status === 'failed' || toolCall.status === 'rejected'

  // Inline media preview URL (image_generate / video_generate / screenshot).
  // Computed once; rendered ALWAYS-visible below the header (even while the
  // tool block is collapsed) so an auto-approved generation shows its picture
  // without the user having to expand the block — konata's "and no image".
  const previewUrl = comfyViewUrlFromResult(toolCall.result)

  // Model-Picker (v2.5.3): while a generation tool call is RUNNING and the
  // executor's pre-VRAM-swap gate is waiting, render the picker inside this
  // block. Once a preference is saved (no picker shows), a mini "Change
  // model" line takes its place so the choice stays one click away.
  const pendingPick = useModelPickStore((s) => s.pending)
  const genKind = pickKindForToolCall(toolCall)
  const showPicker = !!genKind && !!pendingPick && pendingPick.kind === genKind && isRunning

  // Proxy-independent loading (konata 2026-06-08). In browser/dev the tool
  // result carries the RELATIVE `/comfyui/view?…` Vite-proxy path, which loads
  // fine under `npm run dev` (verified E2E). But a built frontend served
  // WITHOUT that dev proxy (e.g. `vite preview` or a static host) would 404 the
  // relative path → no image. If the primary src errors, retry with an ABSOLUTE
  // URL straight to the ComfyUI host: <img>/<video> display is not CORS-gated,
  // so it loads with no server-side proxy. Tauri results are already absolute
  // (they never start with '/') and are unaffected.
  const [imgFailed, setImgFailed] = useState(false)
  const effectivePreviewUrl = (() => {
    if (!previewUrl) return null
    if (imgFailed && previewUrl.startsWith('/')) {
      const path = previewUrl.startsWith('/comfyui/') ? previewUrl.slice('/comfyui'.length) : previewUrl
      return `http://${getComfyHost()}:${getComfyPort()}${path}`
    }
    return previewUrl
  })()

  return (
    <div className="mb-0.5">
      {/* Header line — monochrome, only status icon has subtle color */}
      <button
        onClick={() => setOpen(!open)}
        className="flex items-center gap-1.5 py-0.5 text-left hover:opacity-80 transition-opacity w-full"
      >
        <ToolIcon size={10} className="text-gray-500 dark:text-gray-500 shrink-0" />
        <span className="text-[0.65rem] text-gray-600 dark:text-gray-400">{toolCall.toolName}</span>
        <StatusIcon size={9} className={`shrink-0 ${
          toolCall.status === 'completed' ? 'text-gray-400 dark:text-gray-500' :
          isFailed ? 'text-red-400/60' :
          isPending ? 'text-amber-400/60' :
          'text-gray-500'
        } ${isRunning ? 'animate-spin' : ''}`} />
        {toolCall.duration != null && (
          <span className="text-[0.5rem] text-gray-500 dark:text-gray-600">
            {toolCall.duration < 1000 ? `${toolCall.duration}ms` : `${(toolCall.duration / 1000).toFixed(1)}s`}
          </span>
        )}
      </button>

      {/* Model-Picker (v2.5.3) — LU's own pre-VRAM-swap model choice, shown
          while the executor gate awaits the pick. Falls back to the mini
          "Change model" line once a preference is saved. */}
      {showPicker && pendingPick && <ModelPickerCard request={pendingPick} />}
      {!showPicker && genKind && <ChangeModelInline kind={genKind} />}

      {/* Inline media preview — ALWAYS visible for a completed image/video
          generation, even while the tool block stays collapsed. Before the
          konata 2026-06-07 fix this lived inside the collapsed details, so a
          user with auto-approve (block closed) saw "Image generated: …" text
          and no picture. A .mp4/.webm output renders in a <video>; everything
          else — including animated .webp — in an <img>. URL is bounded to OUR
          ComfyUI by comfyViewUrlFromResult (never auto-loads arbitrary URLs). */}
      {previewUrl && effectivePreviewUrl && (
        <div className="pl-5 pt-0.5 space-y-1">
          {isInlineVideoUrl(effectivePreviewUrl) ? (
            <video
              src={effectivePreviewUrl}
              controls
              loop
              onError={() => { if (!imgFailed) setImgFailed(true) }}
              className="block max-w-full max-h-[320px] rounded border border-gray-200 dark:border-white/[0.06]"
            />
          ) : (
            <a href={effectivePreviewUrl} target="_blank" rel="noopener noreferrer" className="block">
              <img
                src={effectivePreviewUrl}
                alt="Generated image"
                onError={() => { if (!imgFailed) setImgFailed(true) }}
                className="max-w-full max-h-[320px] rounded border border-gray-200 dark:border-white/[0.06]"
                loading="lazy"
              />
            </a>
          )}
          {/* Download (David 2026-06-12): generated media shows in the chat with
              a Download button, ChatGPT-style — downloadComfyFile pulls the real
              bytes and saves via the native dialog. */}
          {(() => {
            const p = comfyViewParams(effectivePreviewUrl)
            if (!p) return null
            return (
              <button
                onClick={() => { void downloadComfyFile(p.filename, p.subfolder, p.type) }}
                title="Download"
                className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[0.6rem] font-medium bg-blue-500/15 text-blue-500 hover:bg-blue-500/25 border border-blue-500/30 transition-colors"
              >
                <Download size={11} /> Download
              </button>
            )
          })()}
        </div>
      )}

      {/* Expandable details */}
      <AnimatePresence>
        {open && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.15 }}
            className="overflow-hidden"
          >
            <div className="pl-5 pb-1.5 space-y-1">
              {/* Arguments */}
              <pre className="text-[0.55rem] leading-relaxed text-gray-500 dark:text-gray-500 bg-gray-50 dark:bg-white/[0.02] rounded px-2 py-1 overflow-x-auto scrollbar-thin">
                {JSON.stringify(toolCall.args, null, 2)}
              </pre>

              {/* Result (raw text). The inline media preview now renders
                  always-visible above the collapsible (konata 2026-06-07). */}
              {toolCall.result && (
                <pre className="text-[0.55rem] leading-relaxed text-gray-600 dark:text-gray-400 bg-gray-50 dark:bg-white/[0.02] rounded px-2 py-1 overflow-auto scrollbar-thin max-h-[300px]">
                  {toolCall.result}
                </pre>
              )}

              {/* Error */}
              {toolCall.error && (
                <pre className="text-[0.55rem] leading-relaxed text-gray-500 dark:text-gray-500 bg-gray-50 dark:bg-white/[0.02] rounded px-2 py-1">
                  {toolCall.error}
                </pre>
              )}

              {/* Approval buttons — subtle green / red as the user
                  asked for ("approve grün, reject rot, sauber, keine
                  Neonfarben"). Sits inline in the pending tool block
                  instead of a popup over the input. Enter / Esc still
                  trigger the head-of-queue approval (handled in
                  ChatView). */}
              {isPending && onApprove && onReject && (
                <div className="flex items-center gap-1.5 pt-1">
                  <button
                    onClick={(e) => { e.stopPropagation(); onApprove() }}
                    className="flex items-center gap-1 px-2.5 py-1 rounded text-[0.6rem] font-medium text-emerald-700 dark:text-emerald-300 bg-emerald-500/10 dark:bg-emerald-500/10 hover:bg-emerald-500/15 dark:hover:bg-emerald-500/15 border border-emerald-500/20 dark:border-emerald-500/25 transition-colors"
                  >
                    <Check size={10} /> Approve
                  </button>
                  <button
                    onClick={(e) => { e.stopPropagation(); onReject() }}
                    className="flex items-center gap-1 px-2.5 py-1 rounded text-[0.6rem] font-medium text-red-700 dark:text-red-300 bg-red-500/10 dark:bg-red-500/10 hover:bg-red-500/15 dark:hover:bg-red-500/15 border border-red-500/20 dark:border-red-500/25 transition-colors"
                  >
                    <X size={10} /> Reject
                  </button>
                  <span className="ml-1 text-[0.5rem] text-gray-400 dark:text-gray-600 font-mono">⏎ / Esc</span>
                </div>
              )}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  )
}
