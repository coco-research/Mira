import { useEffect, useRef, useState } from 'react'
import { Image as ImageIcon, Film, Loader2, Power, ChevronDown, Check } from 'lucide-react'
import { useCreateStore } from '../../stores/createStore'
import { backendCall } from '../../api/backend'
import { classifyModel, checkComfyConnection } from '../../api/comfyui'

/**
 * Create view's top controls (lives inside the app Header when the
 * user is on the Create tab). Pattern mirrors the chat header:
 *   - Model picker — the active image OR video model, driven by
 *     `useCreateStore.mode`. Dropdown picks from the lists discovered
 *     by useCreate() (`imageModelList` / `videoModelList`).
 *   - Lichtschalter — green when ComfyUI is running, red when not,
 *     amber-with-spinner while transitioning. Click flips it.
 *
 * The mode switcher (Image ↔ Video) is exposed here too so the user can
 * flip without scrolling down into the ParamPanel.
 */
export function CreateTopControls() {
  const {
    mode, setMode,
    imageModel, setImageModel,
    videoModel, setVideoModel,
    imageModelList, videoModelList,
    comfyRunning, setComfyRunning,
  } = useCreateStore()

  const [open, setOpen] = useState(false)
  const [comfyBusy, setComfyBusy] = useState<'starting' | 'stopping' | null>(null)
  const startPollRef = useRef<number | null>(null)

  // Close the dropdown when the user clicks somewhere else.
  useEffect(() => {
    if (!open) return
    const onDoc = (e: MouseEvent) => {
      const target = e.target as HTMLElement | null
      if (!target || !target.closest('[data-create-top-picker]')) setOpen(false)
    }
    document.addEventListener('mousedown', onDoc)
    return () => document.removeEventListener('mousedown', onDoc)
  }, [open])

  // Heartbeat poll whenever the toggle lives in the header (independent of
  // whether the full CreateView is mounted). Keeps the Lichtschalter in
  // sync when the user starts/stops ComfyUI from another place (Settings,
  // OS tray, etc.) without mounting the heavy useCreate hook.
  useEffect(() => {
    let cancelled = false
    const tick = async () => {
      if (cancelled) return
      try {
        const alive = await checkComfyConnection()
        if (!cancelled) setComfyRunning(alive)
      } catch { /* keep previous state */ }
    }
    tick() // fire once on mount
    const id = window.setInterval(tick, 5000)
    return () => { cancelled = true; clearInterval(id) }
  }, [setComfyRunning])

  // Always clean up the start-polling interval on unmount.
  useEffect(() => () => {
    if (startPollRef.current != null) {
      clearInterval(startPollRef.current)
      startPollRef.current = null
    }
  }, [])

  // Bulletproof: reported on Discord by @phantomderp (2026-04-24) and
  // @diimmortalis (2026-04-22) — opening the picker crashes the app when
  // the list field is not an array. Can happen with stale persisted state
  // from a very old LU install, Zustand rehydration racing the first render,
  // a corrupted localStorage entry, or an old .exe that predates aa31bab.
  // `Array.isArray` catches undefined / null / object / string — anything
  // weird — and hands the render a safe empty array.
  const rawList = mode === 'image' ? imageModelList : videoModelList
  const activeList = Array.isArray(rawList) ? rawList : []
  const activeModel = mode === 'image' ? imageModel : videoModel
  const onPickModel = (name: string) => {
    if (mode === 'image') {
      const type = classifyModel(name)
      setImageModel(name, type)
    } else {
      setVideoModel(name)
    }
    setOpen(false)
  }

  const onToggleComfy = async () => {
    if (comfyBusy) return
    if (comfyRunning) {
      setComfyBusy('stopping')
      try { await backendCall('stop_comfyui') } catch { }
      setComfyRunning(false)
      setComfyBusy(null)
      return
    }

    // START path — ComfyUI's first boot takes 5–15 s (Python startup,
    // model index build, etc.). The old 800 ms optimistic reset fell
    // back to "red/off" before the server was ready, which the user
    // correctly reported as broken. Instead: keep the amber spinner
    // UNTIL checkComfyConnection() returns 200, or give up after ~60 s.
    setComfyBusy('starting')
    try { await backendCall('start_comfyui') } catch { /* surfaced via poll */ }

    // Stop any previous poll (in case the user mashed the button).
    if (startPollRef.current != null) {
      clearInterval(startPollRef.current)
      startPollRef.current = null
    }

    const startedAt = Date.now()
    const MAX_WAIT_MS = 60_000
    startPollRef.current = window.setInterval(async () => {
      const alive = await checkComfyConnection()
      if (alive) {
        if (startPollRef.current != null) {
          clearInterval(startPollRef.current)
          startPollRef.current = null
        }
        setComfyRunning(true)
        setComfyBusy(null)
      } else if (Date.now() - startedAt > MAX_WAIT_MS) {
        // Giving up — surface a clear red state. The user can retry.
        if (startPollRef.current != null) {
          clearInterval(startPollRef.current)
          startPollRef.current = null
        }
        setComfyRunning(false)
        setComfyBusy(null)
      }
    }, 1500)
  }

  const toggleTitle = comfyBusy
    ? (comfyBusy === 'starting' ? 'Starting ComfyUI…' : 'Stopping ComfyUI…')
    : (comfyRunning ? 'ComfyUI running — click to stop' : 'ComfyUI stopped — click to start')

  return (
    <div className="flex items-center gap-1 min-w-0" data-create-top-picker>
      {/* Image / Video mode switch */}
      <div className="flex items-center rounded-md border border-gray-200 dark:border-white/10 overflow-hidden">
        <button
          onClick={() => setMode('image')}
          className={`px-2 h-[22px] flex items-center gap-1 text-[0.6rem] font-medium transition-colors ${mode === 'image'
            ? 'bg-gray-200 dark:bg-white/10 text-gray-900 dark:text-white'
            : 'text-gray-500 hover:text-gray-800 dark:hover:text-gray-200'
            }`}
          title="Image mode"
        >
          <ImageIcon size={11} />
          <span className="hidden sm:inline">Image</span>
        </button>
        <button
          onClick={() => setMode('video')}
          className={`px-2 h-[22px] flex items-center gap-1 text-[0.6rem] font-medium transition-colors ${mode === 'video'
            ? 'bg-gray-200 dark:bg-white/10 text-gray-900 dark:text-white'
            : 'text-gray-500 hover:text-gray-800 dark:hover:text-gray-200'
            }`}
          title="Video mode"
        >
          <Film size={11} />
          <span className="hidden sm:inline">Video</span>
        </button>
      </div>

      {/* Model picker */}
      <div className="relative">
        <button
          onClick={() => setOpen((v) => !v)}
          className="flex items-center gap-1 h-[22px] px-2 rounded-md text-[0.65rem] text-gray-700 dark:text-gray-200 bg-gray-100 dark:bg-white/5 hover:bg-gray-200 dark:hover:bg-white/10 transition-colors max-w-[120px] sm:max-w-[220px]"
          title={activeModel || `Select ${mode} model`}
        >
          <span className="truncate">{activeModel || `No ${mode} model`}</span>
          <ChevronDown size={10} className={open ? 'rotate-180 transition-transform' : 'transition-transform'} />
        </button>

        {open && (
          <div className="absolute top-[26px] right-0 min-w-[240px] max-h-[340px] overflow-y-auto rounded-md border border-gray-200 dark:border-white/10 bg-white dark:bg-[#151515] shadow-lg z-50">
            {activeList.length === 0 ? (
              <div className="px-3 py-2 text-[0.65rem] text-gray-500">
                {comfyRunning ? `No ${mode} models installed yet` : 'Start ComfyUI to load models'}
              </div>
            ) : (
              activeList.map((m) => (
                <button
                  key={m.name}
                  onClick={() => onPickModel(m.name)}
                  className={`w-full text-left px-3 py-1.5 text-[0.65rem] flex items-center justify-between gap-2 transition-colors ${activeModel === m.name
                    ? 'bg-gray-100 dark:bg-white/10 text-gray-900 dark:text-white'
                    : 'text-gray-600 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-white/5'
                    }`}
                >
                  <span className="truncate">{m.name}</span>
                  {activeModel === m.name && <Check size={11} />}
                </button>
              ))
            )}
          </div>
        )}
      </div>

      {/* ComfyUI power toggle (Lichtschalter) — same shape as the chat
          header's Ollama toggle so the two look identical. */}
      <button
        onClick={onToggleComfy}
        disabled={!!comfyBusy}
        title={toggleTitle}
        aria-label={toggleTitle}
        className={`relative flex items-center h-[18px] w-[34px] rounded-full transition-colors duration-200 ${comfyBusy
          ? 'bg-amber-500/25 border border-amber-400/40'
          : comfyRunning
            ? 'bg-green-500/25 border border-green-400/50'
            : 'bg-red-500/20 border border-red-400/40 hover:bg-red-500/30'
          }`}
      >
        <span
          className={`absolute top-[1px] flex items-center justify-center w-[14px] h-[14px] rounded-full shadow-sm transition-all duration-200 ${comfyBusy
            ? 'left-[9px] bg-amber-400'
            : comfyRunning
              ? 'left-[18px] bg-green-400'
              : 'left-[1px] bg-red-400'
            }`}
        >
          {comfyBusy ? (
            <Loader2 size={9} className="animate-spin text-gray-900" />
          ) : (
            <Power size={9} className="text-gray-900" />
          )}
        </span>
      </button>
    </div>
  )
}
