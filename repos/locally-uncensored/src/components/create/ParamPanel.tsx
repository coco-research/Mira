import { useState, useEffect } from 'react'
import { useCreateStore } from '../../stores/createStore'
import { SliderControl } from '../settings/SliderControl'
import { WorkflowFinder } from './WorkflowFinder'
import { Dice5, AlertTriangle, Film, ImageIcon, ImagePlus } from 'lucide-react'
import type { ClassifiedModel, ModelType } from '../../api/comfyui'
import { snapToVideoGrid, isI2VModel, getLoraModels, getVAEModels } from '../../api/comfyui'

interface Props {
  imageModels: ClassifiedModel[]
  videoModels: ClassifiedModel[]
  samplerList: string[]
  schedulerList: string[]
  modelsLoaded: boolean
  modelLoadError?: string | null
  onRetryModels?: () => void
}

const IMG_SIZE_PRESETS_SD15 = [
  { label: '512', w: 512, h: 512 },
  { label: '512x768', w: 512, h: 768 },
  { label: '768x512', w: 768, h: 512 },
  { label: '768', w: 768, h: 768 },
]

const IMG_SIZE_PRESETS_XL = [
  { label: '1024', w: 1024, h: 1024 },
  { label: '768x1344', w: 768, h: 1344 },
  { label: '1344x768', w: 1344, h: 768 },
  { label: '896x1152', w: 896, h: 1152 },
]

function getImageSizePresets(modelType: ModelType) {
  if (modelType === 'sd15') return IMG_SIZE_PRESETS_SD15
  return IMG_SIZE_PRESETS_XL
}

const VID_SIZE_PRESETS = [
  { label: '480p', w: 848, h: 480 },
  { label: '640x480', w: 640, h: 480 },
  { label: '512', w: 512, h: 512 },
  { label: '480x848', w: 480, h: 848 },
]

const TYPE_BADGE: Record<ModelType, { label: string; color: string }> = {
  flux: { label: 'FLUX', color: 'bg-purple-500/15 text-purple-300' },
  flux2: { label: 'FLUX 2', color: 'bg-purple-500/15 text-purple-300' },
  zimage: { label: 'Z-Image', color: 'bg-rose-500/15 text-rose-300' },
  ernie_image: { label: 'ERNIE', color: 'bg-sky-500/15 text-sky-300' },
  sdxl: { label: 'SDXL', color: 'bg-blue-500/15 text-blue-300' },
  sd15: { label: 'SD 1.5', color: 'bg-green-500/15 text-green-300' },
  wan: { label: 'Wan', color: 'bg-orange-500/15 text-orange-300' },
  wan22: { label: 'Wan 2.2', color: 'bg-orange-500/15 text-orange-300' },
  hunyuan: { label: 'Hunyuan', color: 'bg-red-500/15 text-red-300' },
  ltx: { label: 'LTX', color: 'bg-cyan-500/15 text-cyan-300' },
  mochi: { label: 'Mochi', color: 'bg-pink-500/15 text-pink-300' },
  cosmos: { label: 'Cosmos', color: 'bg-emerald-500/15 text-emerald-300' },
  cogvideo: { label: 'CogVideo', color: 'bg-amber-500/15 text-amber-300' },
  svd: { label: 'SVD', color: 'bg-indigo-500/15 text-indigo-300' },
  framepack: { label: 'FramePack', color: 'bg-teal-500/15 text-teal-300' },
  pyramidflow: { label: 'PyramidFlow', color: 'bg-violet-500/15 text-violet-300' },
  allegro: { label: 'Allegro', color: 'bg-rose-500/15 text-rose-300' },
  unknown: { label: 'Model', color: 'bg-white/10 text-gray-400' },
}

export function ParamPanel({ imageModels, videoModels, samplerList, schedulerList, modelsLoaded, modelLoadError, onRetryModels }: Props) {
  const store = useCreateStore()
  const isVideo = store.mode === 'video'
  const isI2I = store.mode === 'image' && store.imageSubMode === 'img2img'
  // Sub-mode now lives in the store (shared with the main-screen T2V/I2V
  // switch). CreateView owns the always-mounted effect that re-points
  // store.videoModel to a valid entry when the sub-mode changes.
  const videoSubMode = store.videoSubMode
  const sizePresets = isVideo ? VID_SIZE_PRESETS : getImageSizePresets(store.imageModelType)

  // Filter video models by sub-mode
  const filteredVideoModels = isVideo
    ? videoModels.filter(m => videoSubMode === 'i2v' ? isI2VModel(m.name) : !isI2VModel(m.name))
    : videoModels
  const models = isVideo ? filteredVideoModels : imageModels  // i2i also uses imageModels

  const sel = 'w-full px-2.5 py-1.5 rounded-lg bg-gray-100 dark:bg-[#1a1a1a] border border-gray-200 dark:border-white/8 text-gray-900 dark:text-white text-[11px] focus:outline-none focus:border-gray-400 dark:focus:border-white/20 cursor-pointer'
  const lbl = 'text-[10px] font-medium text-gray-500 dark:text-gray-600 uppercase tracking-widest mb-1 block'

  const handleModelChange = (name: string) => {
    if (isVideo) {
      store.setVideoModel(name)
    } else {
      const model = imageModels.find(m => m.name === name)
      store.setImageModel(name, model?.type ?? 'unknown')
    }
  }

  const activeModel = isVideo ? store.videoModel : store.imageModel

  return (
    <div className="space-y-3">
      {/* Video Sub-Tabs: Text to Video / Image to Video */}
      {isVideo && (
        <div className="flex rounded-lg bg-gray-100 dark:bg-white/5 p-0.5 gap-0.5">
          <button
            onClick={() => store.setVideoSubMode('t2v')}
            className={`flex-1 flex items-center justify-center gap-1.5 px-2 py-1.5 rounded-md text-[10px] font-medium transition-all ${
              videoSubMode === 't2v'
                ? 'bg-white dark:bg-white/15 text-gray-900 dark:text-white shadow-sm'
                : 'text-gray-500 hover:text-gray-700 dark:hover:text-gray-300'
            }`}
          >
            <Film size={11} />
            Text to Video
          </button>
          <button
            onClick={() => store.setVideoSubMode('i2v')}
            className={`flex-1 flex items-center justify-center gap-1.5 px-2 py-1.5 rounded-md text-[10px] font-medium transition-all ${
              videoSubMode === 'i2v'
                ? 'bg-white dark:bg-white/15 text-gray-900 dark:text-white shadow-sm'
                : 'text-gray-500 hover:text-gray-700 dark:hover:text-gray-300'
            }`}
          >
            <ImageIcon size={11} />
            Image to Video
          </button>
        </div>
      )}

      {/* Image Sub-Tabs: Text to Image / Image to Image */}
      {!isVideo && (
        <div className="flex rounded-lg bg-gray-100 dark:bg-white/5 p-0.5 gap-0.5">
          <button
            onClick={() => store.setImageSubMode('text2img')}
            className={`flex-1 flex items-center justify-center gap-1.5 px-2 py-1.5 rounded-md text-[10px] font-medium transition-all ${
              store.imageSubMode === 'text2img'
                ? 'bg-white dark:bg-white/15 text-gray-900 dark:text-white shadow-sm'
                : 'text-gray-500 hover:text-gray-700 dark:hover:text-gray-300'
            }`}
          >
            <ImageIcon size={11} />
            Text to Image
          </button>
          <button
            onClick={() => store.setImageSubMode('img2img')}
            className={`flex-1 flex items-center justify-center gap-1.5 px-2 py-1.5 rounded-md text-[10px] font-medium transition-all ${
              store.imageSubMode === 'img2img'
                ? 'bg-white dark:bg-white/15 text-gray-900 dark:text-white shadow-sm'
                : 'text-gray-500 hover:text-gray-700 dark:hover:text-gray-300'
            }`}
          >
            <ImagePlus size={11} />
            Image to Image
          </button>
        </div>
      )}

      {/* Model */}
      <div>
        <label className={lbl}>{isVideo ? (videoSubMode === 'i2v' ? 'I2V Model' : 'Video Model') : 'Image Model'}</label>
        {modelLoadError ? (
          <div className="space-y-1">
            <div className="px-2.5 py-1.5 rounded-lg bg-red-500/10 border border-red-500/20 text-red-400 text-[10px]">
              {modelLoadError}
            </div>
            {onRetryModels && (
              <button onClick={onRetryModels} className="text-[9px] text-gray-500 hover:text-gray-300 transition-colors">
                Retry
              </button>
            )}
          </div>
        ) : !modelsLoaded ? (
          <div className="px-2.5 py-1.5 rounded-lg bg-gray-100 dark:bg-white/5 border border-gray-200 dark:border-white/8 text-gray-400 dark:text-gray-600 text-[10px] animate-pulse">
            Loading models from ComfyUI...
          </div>
        ) : models.length === 0 ? (
          <div className="px-2.5 py-1.5 rounded-lg bg-yellow-500/5 border border-yellow-500/10 text-yellow-400 text-[10px]">
            No models found. Download models in the Model Manager.
          </div>
        ) : (
          <>
            <select value={activeModel} onChange={(e) => handleModelChange(e.target.value)} className={sel}>
              {models.map((m) => {
                const badge = TYPE_BADGE[m.type]
                const shortName = m.name.replace(/\.[^.]+$/, '')
                return <option key={m.name} value={m.name}>{shortName} ({badge.label})</option>
              })}
            </select>
            {activeModel && (() => {
              const model = models.find(m => m.name === activeModel)
              if (!model) return null
              const badge = TYPE_BADGE[model.type]
              return (
                <span className={`mt-1 inline-block px-1.5 py-0.5 rounded text-[9px] font-medium ${badge.color}`}>
                  {badge.label}
                </span>
              )
            })()}
          </>
        )}
      </div>

      {/* Sampler + Scheduler side by side */}
      <div className="grid grid-cols-2 gap-2">
        <div>
          <label className={lbl}>Sampler</label>
          <select value={store.sampler} onChange={(e) => store.setSampler(e.target.value)} className={sel}>
            {samplerList.map((s) => <option key={s} value={s}>{s}</option>)}
          </select>
        </div>
        <div>
          <label className={lbl}>Scheduler</label>
          <select value={store.scheduler} onChange={(e) => store.setScheduler(e.target.value)} className={sel}>
            {schedulerList.map((s) => <option key={s} value={s}>{s}</option>)}
          </select>
        </div>
      </div>

      {/* Steps + CFG side by side */}
      <div className="grid grid-cols-2 gap-2">
        <SliderControl label="Steps" value={store.steps} min={1} max={50} step={1} onChange={store.setSteps} />
        <SliderControl label="CFG" value={store.cfgScale} min={0} max={30} step={0.5} onChange={store.setCfgScale} />
      </div>

      {/* Batch Size (not for I2I) */}
      {!isVideo && !isI2I && (
        <SliderControl label="Batch" value={store.batchSize} min={1} max={4} step={1} onChange={store.setBatchSize} />
      )}

      {/* Denoise Strength (I2I only) */}
      {isI2I && (
        <SliderControl label="Denoise" value={store.denoise} min={0.05} max={1.0} step={0.05} onChange={store.setDenoise} />
      )}

      {/* F2 (cinemazverev GH#4) + F3 (vanja-san GH#4) — extended params.
          LoRA / VAE / Skip CLIP only matter for image generation; we
          hide them for video to keep the panel terse. The LoRA list is
          fetched lazily from ComfyUI's LoraLoader node enum the first
          time the panel mounts. */}
      {!isVideo && (
        <ExtendedComfyParams />
      )}

      {/* Size */}
      <div>
        <label className={lbl}>Size ({store.width}x{store.height})</label>
        <div className="flex flex-wrap gap-1">
          {sizePresets.map((preset) => (
            <button
              key={preset.label}
              onClick={() => store.setSize(preset.w, preset.h)}
              className={`px-1.5 py-0.5 rounded text-[10px] transition-all ${
                store.width === preset.w && store.height === preset.h
                  ? 'bg-gray-800 dark:bg-white/15 text-white'
                  : 'bg-gray-100 dark:bg-white/5 text-gray-500 hover:bg-gray-200 dark:hover:bg-white/10 hover:text-gray-700 dark:hover:text-gray-300'
              }`}
            >
              {preset.label}
            </button>
          ))}
        </div>
      </div>

      {/* Seed */}
      <div>
        <label className={lbl}>Seed</label>
        <div className="flex gap-1.5">
          <input
            type="number"
            value={store.seed}
            onChange={(e) => store.setSeed(parseInt(e.target.value) || -1)}
            className="flex-1 px-2.5 py-1.5 rounded-lg bg-gray-100 dark:bg-white/5 border border-gray-200 dark:border-white/8 text-gray-900 dark:text-white text-[11px] focus:outline-none font-mono"
            placeholder="-1"
          />
          <button
            onClick={() => store.setSeed(-1)}
            className="p-1.5 rounded-lg bg-gray-100 dark:bg-white/5 border border-gray-200 dark:border-white/8 text-gray-500 hover:text-gray-900 dark:hover:text-white transition-colors"
            title="Random"
            aria-label="Random seed"
          >
            <Dice5 size={12} />
          </button>
        </div>
      </div>

      {/* Video params */}
      {isVideo && (
        <>
          <div className="grid grid-cols-2 gap-2">
            <SliderControl label="Frames" value={store.frames} min={1} max={81} step={4} onChange={store.setFrames} />
            <SliderControl label="FPS" value={store.fps} min={4} max={30} step={1} onChange={store.setFps} />
          </div>
          {(store.width % 16 !== 0 || store.height % 16 !== 0) && (
            <button
              onClick={() => { const s = snapToVideoGrid(store.width, store.height); store.setSize(s.width, s.height) }}
              className="flex items-center gap-1 text-[10px] text-yellow-400 hover:underline"
              aria-label="Fix video dimensions"
            >
              <AlertTriangle size={10} /> Fix to {snapToVideoGrid(store.width, store.height).width}x{snapToVideoGrid(store.width, store.height).height}
            </button>
          )}
          {store.frames > 40 && (
            <div className="flex items-center gap-1 text-[10px] text-orange-400">
              <AlertTriangle size={10} /> High VRAM usage
            </div>
          )}
        </>
      )}

      {/* Workflow (bottom) */}
      <div className="pt-2 border-t border-gray-200 dark:border-white/5">
        <WorkflowFinder
          modelName={activeModel}
          modelType={isVideo ? (models.find(m => m.name === activeModel)?.type ?? 'unknown') : store.imageModelType}
        />
      </div>
    </div>
  )
}

// ── F2 + F3 extended params (image generation only) ──────────────
//
// Lazy-loads the LoRA + VAE enum from ComfyUI's `/object_info/...` once
// per mount. Both lists silently fall back to empty when the node isn't
// registered — F2/F3 then degrade to "no LoRA" / "VAE: auto".

function ExtendedComfyParams() {
  const store = useCreateStore()
  const [loras, setLoras] = useState<string[]>([])
  const [vaes, setVaes] = useState<string[]>([])
  const [loaded, setLoaded] = useState(false)

  useEffect(() => {
    let cancelled = false
    void Promise.all([getLoraModels(), getVAEModels()]).then(([l, v]) => {
      if (cancelled) return
      setLoras(l)
      setVaes(v)
      setLoaded(true)
    })
    return () => {
      cancelled = true
    }
  }, [])

  const sel = 'w-full px-2 py-1 rounded bg-gray-50 dark:bg-white/[0.04] border border-gray-200 dark:border-white/10 text-[0.7rem] text-gray-800 dark:text-gray-200 focus:outline-none focus:border-blue-400/40'
  const lbl = 'text-[0.55rem] text-gray-500 mb-1 block'

  return (
    <div className="space-y-2 pt-1 border-t border-gray-200 dark:border-white/5">
      <div className="text-[0.55rem] uppercase tracking-widest text-gray-500">Extended</div>

      {/* LoRA stack (F2 + multi-LoRA, konata 2026-06-09) — click to stack;
          applied in click order via chained LoraLoader nodes, each with its
          own strength slider. */}
      <div>
        <label className={lbl}>
          LoRAs {!loaded && <span className="text-gray-400">(loading…)</span>}
          {store.selectedLoras.length > 1 && (
            <span className="ml-1 text-gray-400">— {store.selectedLoras.length} stacked, applied in order</span>
          )}
        </label>
        {loaded && loras.length === 0 && (
          <div className="text-[0.6rem] text-gray-500">No LoRAs installed (ComfyUI/models/loras)</div>
        )}
        <div className="space-y-1 max-h-44 overflow-y-auto scrollbar-thin pr-0.5">
          {loras.map((l) => {
            const active = store.selectedLoras.find((x) => x.name === l)
            return (
              <div key={l}>
                <button
                  type="button"
                  onClick={() => store.toggleLora(l)}
                  disabled={!loaded}
                  className={`w-full text-left px-2 py-1 rounded border text-[0.65rem] transition-colors truncate ${
                    active
                      ? 'border-blue-400/40 bg-blue-500/10 text-gray-900 dark:text-gray-100'
                      : 'border-gray-200 dark:border-white/10 bg-gray-50 dark:bg-white/[0.04] text-gray-600 dark:text-gray-400 hover:border-gray-300 dark:hover:border-white/20'
                  }`}
                  title={l}
                >
                  {active ? '✓ ' : ''}{l}
                </button>
                {active && (
                  <SliderControl
                    label="strength"
                    value={active.strength}
                    min={0}
                    max={2}
                    step={0.05}
                    onChange={(v) => store.setLoraStrengthFor(l, v)}
                  />
                )}
              </div>
            )
          })}
        </div>
      </div>

      {/* VAE override (F3) */}
      <div>
        <label className={lbl}>VAE</label>
        <select
          value={store.selectedVae}
          onChange={(e) => store.setSelectedVae(e.target.value)}
          className={sel}
          disabled={!loaded}
        >
          <option value="auto">auto (use checkpoint VAE)</option>
          {vaes.map((v) => (
            <option key={v} value={v}>{v}</option>
          ))}
        </select>
      </div>

      {/* Skip CLIP (F3) — 0 = none. 1-2 is the SD1.5 / SDXL sweet spot
          for some abliterated finetunes. >2 only makes sense for very
          specialised use. */}
      <SliderControl
        label="Skip CLIP layers"
        value={store.clipSkip}
        min={0}
        max={12}
        step={1}
        onChange={store.setClipSkip}
      />
    </div>
  )
}
