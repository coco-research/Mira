// Bug BB v2.5.0 — BobbyT Discord 2026-05-26. GPU picker UI. Detects GPUs via
// the Rust `detect_gpus` command, lets the user pick vendor + indices, and
// forwards the selection to AppState via `set_gpu_selection`. Applied on
// next Ollama / ComfyUI spawn (current processes need a restart).

import { useEffect, useMemo, useState } from 'react'
import { useSettingsStore } from '../../stores/settingsStore'
import { backendCall } from '../../api/backend'
import { Cpu, RefreshCw, AlertTriangle } from 'lucide-react'

interface DetectedGpu {
  index: number
  vendor: string
  name: string
  memory_mib: number | null
  source: string
}

type GpuVendor = 'auto' | 'nvidia' | 'amd' | 'intel'

const VENDOR_LABELS: Record<GpuVendor, string> = {
  auto: 'Auto (let runtime decide)',
  nvidia: 'NVIDIA (CUDA_VISIBLE_DEVICES)',
  amd: 'AMD (HIP_VISIBLE_DEVICES)',
  intel: 'Intel (ONEAPI_DEVICE_SELECTOR)',
}

const VENDOR_HELP: Record<GpuVendor, string> = {
  auto: 'No env-var set. Ollama / ComfyUI use whatever the driver picks first. This matches pre-v2.5.0 behaviour.',
  nvidia: 'Forwards CUDA_VISIBLE_DEVICES. Use on NVIDIA-only or NVIDIA+iGPU setups.',
  amd: 'Forwards HIP_VISIBLE_DEVICES + ROCR_VISIBLE_DEVICES. Works on ROCm Linux + ROCm-on-Windows.',
  intel: 'Forwards ONEAPI_DEVICE_SELECTOR. For Intel Arc / Iris with IPEX-LLM. Ollama support is limited — verify your engine first.',
}

export function HardwareSettings() {
  const { settings, updateSettings } = useSettingsStore()
  const [gpus, setGpus] = useState<DetectedGpu[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [showRestartHint, setShowRestartHint] = useState(false)

  const vendor = (settings.gpuVendor || 'auto') as GpuVendor
  const indices = settings.gpuIndices || []

  const detect = async () => {
    setLoading(true)
    setError(null)
    try {
      const result = await backendCall<DetectedGpu[]>('detect_gpus')
      setGpus(Array.isArray(result) ? result : [])
    } catch (e) {
      setError(`GPU detection failed: ${e instanceof Error ? e.message : String(e)}`)
      setGpus([])
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    detect()
  }, [])

  // Push selection to AppState on every change so the next ollama / comfyui
  // spawn picks it up. No-op when not running in Tauri (dev mode).
  useEffect(() => {
    backendCall('set_gpu_selection', { selection: { vendor, indices } }).catch(() => {})
  }, [vendor, indices])

  const gpusForVendor = useMemo(() => {
    if (vendor === 'auto') return gpus
    return gpus.filter(g => g.vendor === vendor)
  }, [gpus, vendor])

  const setVendor = (v: GpuVendor) => {
    updateSettings({ gpuVendor: v, gpuIndices: [] }) // reset indices when vendor changes
    setShowRestartHint(true)
  }

  const toggleIndex = (idx: number) => {
    const next = indices.includes(idx)
      ? indices.filter(i => i !== idx)
      : [...indices, idx].sort((a, b) => a - b)
    updateSettings({ gpuIndices: next })
    setShowRestartHint(true)
  }

  return (
    <div className="space-y-3">
      <div className="flex items-start gap-2.5 p-2.5 rounded-lg border border-amber-200 dark:border-amber-500/20 bg-amber-50 dark:bg-amber-500/[0.08] text-amber-900 dark:text-amber-200">
        <Cpu size={14} className="mt-0.5 shrink-0" />
        <div className="text-[0.65rem] leading-relaxed">
          <strong>GPU picker.</strong> Forwards CUDA_VISIBLE_DEVICES / HIP_VISIBLE_DEVICES / ONEAPI_DEVICE_SELECTOR to Ollama + ComfyUI on next spawn. Use only on multi-GPU / multi-vendor systems where the driver picks the wrong device by default.
        </div>
      </div>

      <div>
        <div className="flex items-center justify-between mb-1.5">
          <span className="text-[0.7rem] text-gray-700 dark:text-gray-300 font-medium">Vendor</span>
          <button
            onClick={detect}
            disabled={loading}
            className="text-[0.6rem] text-gray-500 hover:text-gray-300 inline-flex items-center gap-1 disabled:opacity-50"
            aria-label="Re-detect GPUs"
          >
            <RefreshCw size={10} className={loading ? 'animate-spin' : ''} />
            Re-detect
          </button>
        </div>
        <div className="grid grid-cols-1 gap-1">
          {(Object.keys(VENDOR_LABELS) as GpuVendor[]).map(v => (
            <label key={v} className="flex items-start gap-2 cursor-pointer p-1.5 rounded hover:bg-white/[0.04] border border-transparent has-[input:checked]:border-white/10 has-[input:checked]:bg-white/[0.03]">
              <input
                type="radio"
                name="gpu-vendor"
                checked={vendor === v}
                onChange={() => setVendor(v)}
                className="mt-0.5"
              />
              <div className="flex-1 min-w-0">
                <div className="text-[0.65rem] text-gray-300">{VENDOR_LABELS[v]}</div>
                <div className="text-[0.55rem] text-gray-500 mt-0.5 leading-relaxed">{VENDOR_HELP[v]}</div>
              </div>
            </label>
          ))}
        </div>
      </div>

      <div>
        <div className="text-[0.7rem] text-gray-700 dark:text-gray-300 font-medium mb-1">Detected GPUs</div>
        {error && (
          <div className="flex items-start gap-2 p-2 rounded border border-red-500/20 bg-red-500/[0.06] text-red-300 mb-1.5">
            <AlertTriangle size={12} className="mt-0.5 shrink-0" />
            <span className="text-[0.6rem]">{error}</span>
          </div>
        )}
        {!error && gpus.length === 0 && !loading && (
          <div className="text-[0.6rem] text-gray-500 italic">
            No GPUs detected via nvidia-smi / rocm-smi / lspci / wmic. The "Auto" vendor option still works — Ollama will use whatever the driver picks.
          </div>
        )}
        {gpusForVendor.length > 0 && (
          <div className="space-y-1">
            {gpusForVendor.map(g => {
              const checked = indices.includes(g.index)
              const isAuto = vendor === 'auto'
              return (
                <label
                  key={`${g.vendor}-${g.index}-${g.name}`}
                  className={`flex items-center gap-2 p-1.5 rounded border ${
                    isAuto ? 'border-white/5 opacity-60 cursor-not-allowed' : 'border-white/8 hover:bg-white/[0.04] cursor-pointer'
                  }`}
                >
                  <input
                    type="checkbox"
                    checked={checked && !isAuto}
                    disabled={isAuto}
                    onChange={() => toggleIndex(g.index)}
                  />
                  <div className="flex-1 min-w-0">
                    <div className="text-[0.65rem] text-gray-200 truncate">
                      <span className="font-mono text-gray-500">#{g.index}</span> {g.name}
                    </div>
                    <div className="text-[0.55rem] text-gray-500">
                      {g.vendor}
                      {g.memory_mib ? ` · ${(g.memory_mib / 1024).toFixed(1)} GB` : ''}
                      {` · via ${g.source}`}
                    </div>
                  </div>
                </label>
              )
            })}
          </div>
        )}
        {vendor !== 'auto' && gpusForVendor.length === 0 && gpus.length > 0 && !loading && (
          <div className="text-[0.6rem] text-amber-300 italic mt-1">
            No {vendor.toUpperCase()} GPUs detected on this system. Either install the vendor tool ({vendor === 'nvidia' ? 'nvidia-smi' : vendor === 'amd' ? 'rocm-smi' : 'driver providing lspci/wmic info'}) or switch back to "Auto".
          </div>
        )}
      </div>

      {showRestartHint && (vendor !== 'auto' || indices.length > 0) && (
        <div className="text-[0.6rem] text-amber-300 italic">
          GPU pick takes effect on next Ollama / ComfyUI spawn. Restart both via the Power button (top-right) or close LU to apply.
        </div>
      )}
    </div>
  )
}
