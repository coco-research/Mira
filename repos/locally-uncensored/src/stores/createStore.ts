import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import type { ModelType, ClassifiedModel } from '../api/comfyui'
import { classifyModel } from '../api/comfyui'
import type { PreflightError } from '../api/preflight'
// ModelType includes: flux, flux2, zimage, sdxl, sd15, wan, hunyuan, unknown

export type ProgressPhase = 'idle' | 'queued' | 'loading-model' | 'loading-clip' | 'loading-vae' | 'sampling' | 'decoding' | 'complete'

// ─── Optimal defaults per model type (research-backed: Draw Things, Fooocus, ComfyUI) ───

export const MODEL_TYPE_DEFAULTS: Record<ModelType, {
  steps: number; cfgScale: number; sampler: string; scheduler: string
  width: number; height: number; frames?: number; fps?: number
}> = {
  sd15:    { steps: 25, cfgScale: 7.0, sampler: 'euler_ancestral', scheduler: 'normal', width: 512,  height: 512 },
  sdxl:    { steps: 25, cfgScale: 7.0, sampler: 'dpmpp_2m',       scheduler: 'karras', width: 1024, height: 1024 },
  flux:    { steps: 20, cfgScale: 1.0, sampler: 'euler',           scheduler: 'simple', width: 1024, height: 1024 },
  flux2:   { steps: 20, cfgScale: 1.0, sampler: 'euler',           scheduler: 'simple', width: 1024, height: 1024 },
  zimage:  { steps: 12, cfgScale: 3.5, sampler: 'euler',           scheduler: 'simple', width: 1024, height: 1024 },
  wan:     { steps: 25, cfgScale: 5.0, sampler: 'euler',           scheduler: 'normal', width: 848,  height: 480, frames: 49, fps: 16 },
  wan22:   { steps: 30, cfgScale: 5.0, sampler: 'euler',           scheduler: 'simple', width: 1024, height: 576, frames: 49, fps: 24 },
  hunyuan: { steps: 30, cfgScale: 6.0, sampler: 'euler',           scheduler: 'normal', width: 848,  height: 480, frames: 45, fps: 15 },
  ltx:     { steps: 20, cfgScale: 1.0, sampler: 'euler',           scheduler: 'simple', width: 768,  height: 512, frames: 97, fps: 24 },
  unknown: { steps: 20, cfgScale: 7.0, sampler: 'euler',           scheduler: 'normal', width: 1024, height: 1024 },
}

export interface GalleryItem {
  id: string
  type: 'image' | 'video'
  filename: string
  subfolder: string
  prompt: string
  negativePrompt: string
  model: string
  modelType: ModelType
  seed: number
  steps: number
  cfgScale: number
  sampler: string
  scheduler: string
  width: number
  height: number
  batchSize: number
  createdAt: number
  builderUsed?: 'dynamic' | 'legacy' | 'custom'
  resolvedVAE?: string
  resolvedCLIP?: string
}

interface CreateState {
  mode: 'image' | 'video'
  imageSubMode: 'text2img' | 'img2img'
  // Video sub-mode mirrors imageSubMode so the main Create screen can offer a
  // Text-to-Video / Image-to-Video switch (the I2V upload + model filter key
  // off this). Session-only (not persisted), defaults to 't2v' each launch.
  videoSubMode: 't2v' | 'i2v'
  prompt: string
  negativePrompt: string
  imageModel: string
  imageModelType: ModelType
  videoModel: string
  sampler: string
  scheduler: string
  steps: number
  cfgScale: number
  width: number
  height: number
  seed: number
  batchSize: number
  frames: number
  fps: number
  denoise: number  // Denoise strength for I2I (0.0–1.0)
  // F2 (cinemazverev GH#4), multi-LoRA (konata 2026-06-09) — ordered LoRA
  // stack. Each entry chains another LoraLoader in the workflow; per-entry
  // strength mirrors LoraLoader's `strength_model` slider (0..2 in the UI).
  // Empty array = no LoRA. Session-only (not in partialize), like before.
  selectedLoras: { name: string; strength: number }[]
  // F3 (vanja-san GH#4) — top extended ComfyUI params surfaced in
  // the param panel. selectedVae = 'auto' lets the checkpoint's
  // bundled VAE win; an explicit pick overrides with a VAELoader.
  // clipSkip = 0 means no Skip-CLIP layer is injected.
  selectedVae: string
  clipSkip: number
  i2iImage: string | null  // Uploaded image filename for I2I
  i2vImage: string | null  // Uploaded image filename for I2V models (SVD, FramePack)
  isGenerating: boolean
  progress: number
  progressText: string
  progressPhase: ProgressPhase
  currentPromptId: string | null
  error: string | null
  lastGenTime: string | null
  preflightReady: boolean | null
  preflightErrors: PreflightError[]
  preflightWarnings: string[]
  gallery: GalleryItem[]
  promptHistory: string[]
  /** Runtime-only (not persisted): populated by useCreate.fetchModels so the
   * header-level CreateTopControls can render its model dropdown + Lichtschalter
   * without hosting its own ComfyUI fetching. */
  imageModelList: ClassifiedModel[]
  videoModelList: ClassifiedModel[]
  comfyRunning: boolean
  /** Bug A (v2.4.5): when video generation is about to fall back to .webp
   * because VHS_VideoCombine is missing, useCreate sets this resolver and
   * CreateView pops the modal. The user picks "install", "webp", or
   * "cancel"; resolver fires with the choice and useCreate continues. */
  vhsInstallPrompt: ((choice: 'install' | 'webp' | 'cancel') => void) | null

  setPreflightStatus: (ready: boolean | null, errors: PreflightError[], warnings: string[]) => void
  setMode: (mode: 'image' | 'video') => void
  setImageSubMode: (subMode: 'text2img' | 'img2img') => void
  setVideoSubMode: (subMode: 't2v' | 'i2v') => void
  setPrompt: (prompt: string) => void
  setNegativePrompt: (negativePrompt: string) => void
  setImageModel: (model: string, type: ModelType) => void
  setVideoModel: (model: string) => void
  setSampler: (sampler: string) => void
  setScheduler: (scheduler: string) => void
  setSteps: (steps: number) => void
  setCfgScale: (cfgScale: number) => void
  setSize: (width: number, height: number) => void
  setSeed: (seed: number) => void
  setBatchSize: (batchSize: number) => void
  setFrames: (frames: number) => void
  setFps: (fps: number) => void
  setDenoise: (denoise: number) => void
  /** Toggle a LoRA in/out of the stack (added at the end, default 0.8). */
  toggleLora: (name: string) => void
  /** Set the strength of one stacked LoRA (clamped 0..2 like the old slider). */
  setLoraStrengthFor: (name: string, strength: number) => void
  clearLoras: () => void
  setSelectedVae: (name: string) => void
  setClipSkip: (skip: number) => void
  setI2iImage: (image: string | null) => void
  setI2vImage: (image: string | null) => void
  setIsGenerating: (generating: boolean) => void
  setProgress: (progress: number, text?: string) => void
  setProgressPhase: (phase: ProgressPhase) => void
  setCurrentPromptId: (id: string | null) => void
  setError: (error: string | null) => void
  setLastGenTime: (time: string | null) => void
  addToGallery: (item: GalleryItem) => void
  removeFromGallery: (id: string) => void
  clearGallery: () => void
  addToPromptHistory: (prompt: string) => void
  setImageModelList: (list: ClassifiedModel[]) => void
  setVideoModelList: (list: ClassifiedModel[]) => void
  setComfyRunning: (running: boolean) => void
  setVhsInstallPrompt: (resolver: ((choice: 'install' | 'webp' | 'cancel') => void) | null) => void
}

export const useCreateStore = create<CreateState>()(
  persist(
    (set) => ({
      mode: 'image',
      imageSubMode: 'text2img' as 'text2img' | 'img2img',
      videoSubMode: 't2v' as 't2v' | 'i2v',
      prompt: '',
      negativePrompt: '',
      imageModel: '',
      imageModelType: 'unknown' as ModelType,
      videoModel: '',
      sampler: 'euler',
      scheduler: 'normal',
      steps: 20,
      cfgScale: 7,
      width: 1024,
      height: 1024,
      seed: -1,
      batchSize: 1,
      frames: 24,
      fps: 8,
      denoise: 0.7,
      selectedLoras: [],
      selectedVae: 'auto',
      clipSkip: 0,
      i2iImage: null,
      i2vImage: null,
      isGenerating: false,
      progress: 0,
      progressText: '',
      progressPhase: 'idle' as ProgressPhase,
      currentPromptId: null,
      error: null,
      lastGenTime: null,
      preflightReady: null,
      preflightErrors: [],
      preflightWarnings: [],
      gallery: [],
      promptHistory: [],
      imageModelList: [],
      videoModelList: [],
      comfyRunning: false,
      vhsInstallPrompt: null,

      setPreflightStatus: (ready, errors, warnings) => set({ preflightReady: ready, preflightErrors: errors, preflightWarnings: warnings }),
      setMode: (mode) => set((state) => {
        // Reset parameters to the correct defaults when switching modes
        // This prevents image resolution (1024x1024) leaking into video mode (causes HTTP 500)
        if (mode === 'video' && state.videoModel) {
          const type = classifyModel(state.videoModel)
          const defaults = MODEL_TYPE_DEFAULTS[type] || MODEL_TYPE_DEFAULTS.unknown
          return {
            mode,
            steps: defaults.steps, cfgScale: defaults.cfgScale,
            sampler: defaults.sampler, scheduler: defaults.scheduler,
            width: defaults.width, height: defaults.height,
            ...(defaults.frames ? { frames: defaults.frames } : {}),
            ...(defaults.fps ? { fps: defaults.fps } : {}),
          }
        }
        if (mode === 'image' && state.imageModel) {
          const defaults = MODEL_TYPE_DEFAULTS[state.imageModelType] || MODEL_TYPE_DEFAULTS.unknown
          return {
            mode,
            steps: defaults.steps, cfgScale: defaults.cfgScale,
            sampler: defaults.sampler, scheduler: defaults.scheduler,
            width: defaults.width, height: defaults.height,
          }
        }
        return { mode }
      }),
      setImageSubMode: (subMode) => set({ imageSubMode: subMode }),
      // Plain setter — CreateView owns an always-mounted effect that re-points
      // videoModel to a valid entry for the chosen sub-mode (so toggling works
      // whether or not the Advanced panel is open).
      setVideoSubMode: (subMode: 't2v' | 'i2v') => set({ videoSubMode: subMode }),
      setPrompt: (prompt) => set({ prompt }),
      setNegativePrompt: (negativePrompt) => set({ negativePrompt }),
      setImageModel: (model, type) => {
        const defaults = MODEL_TYPE_DEFAULTS[type]
        set({
          imageModel: model, imageModelType: type,
          steps: defaults.steps, cfgScale: defaults.cfgScale,
          sampler: defaults.sampler, scheduler: defaults.scheduler,
          width: defaults.width, height: defaults.height,
        })
      },
      setVideoModel: (model) => {
        const type = classifyModel(model)
        const defaults = MODEL_TYPE_DEFAULTS[type] || MODEL_TYPE_DEFAULTS.unknown
        set({
          videoModel: model,
          steps: defaults.steps, cfgScale: defaults.cfgScale,
          sampler: defaults.sampler, scheduler: defaults.scheduler,
          width: defaults.width, height: defaults.height,
          ...(defaults.frames ? { frames: defaults.frames } : {}),
          ...(defaults.fps ? { fps: defaults.fps } : {}),
        })
      },
      setSampler: (sampler) => set({ sampler }),
      setScheduler: (scheduler) => set({ scheduler }),
      setSteps: (steps) => set({ steps: Math.max(1, Math.min(200, Math.floor(steps))) }),
      setCfgScale: (cfgScale) => set({ cfgScale: Math.max(0, Math.min(30, cfgScale)) }),
      setSize: (width, height) => set({
        width: Math.max(64, Math.min(4096, Math.floor(width))),
        height: Math.max(64, Math.min(4096, Math.floor(height))),
      }),
      setSeed: (seed) => set({ seed: Math.floor(seed) }),
      setBatchSize: (batchSize) => set({ batchSize: Math.max(1, Math.min(8, Math.floor(batchSize))) }),
      setFrames: (frames) => set({ frames: Math.max(1, Math.min(120, Math.floor(frames))) }),
      setFps: (fps) => set({ fps: Math.max(1, Math.min(60, Math.floor(fps))) }),
      setDenoise: (denoise) => set({ denoise: Math.max(0, Math.min(1, denoise)) }),
      // Explicit param types: this file's creator lost contextual typing long
      // ago (pre-existing TS2740 on MODEL_TYPE_DEFAULTS) — without these the
      // params would be implicit-any like the older setters around them.
      toggleLora: (name: string) => set((s: CreateState) => {
        if (!name) return {}
        const exists = s.selectedLoras.some((l) => l.name === name)
        return {
          selectedLoras: exists
            ? s.selectedLoras.filter((l) => l.name !== name)
            : [...s.selectedLoras, { name, strength: 0.8 }],
        }
      }),
      setLoraStrengthFor: (name: string, strength: number) => set((s: CreateState) => ({
        selectedLoras: s.selectedLoras.map((l) =>
          l.name === name ? { ...l, strength: Math.max(0, Math.min(2, strength)) } : l,
        ),
      })),
      clearLoras: () => set({ selectedLoras: [] }),
      setSelectedVae: (name) => set({ selectedVae: name || 'auto' }),
      setClipSkip: (skip) => set({ clipSkip: Math.max(0, Math.min(12, Math.floor(skip))) }),
      setI2iImage: (image) => set({ i2iImage: image }),
      setI2vImage: (image) => set({ i2vImage: image }),
      setIsGenerating: (generating) => set({ isGenerating: generating, ...(generating ? {} : { progressPhase: 'idle' as ProgressPhase }) }),
      setProgress: (progress, text) => set({ progress, progressText: text ?? '' }),
      setProgressPhase: (phase) => set({ progressPhase: phase }),
      setCurrentPromptId: (id) => set({ currentPromptId: id }),
      setError: (error) => set({ error }),
      setLastGenTime: (time) => set({ lastGenTime: time }),
      addToGallery: (item) => set((s) => ({ gallery: [item, ...s.gallery].slice(0, 200) })),
      removeFromGallery: (id) => set((s) => ({ gallery: s.gallery.filter((g) => g.id !== id) })),
      clearGallery: () => set({ gallery: [] }),
      addToPromptHistory: (prompt) => set((s) => {
        const filtered = s.promptHistory.filter(p => p !== prompt)
        return { promptHistory: [prompt, ...filtered].slice(0, 50) }
      }),
      setImageModelList: (list) => set({ imageModelList: list }),
      setVideoModelList: (list) => set({ videoModelList: list }),
      setComfyRunning: (running) => set({ comfyRunning: running }),
      setVhsInstallPrompt: (resolver) => set({ vhsInstallPrompt: resolver }),
    }),
    {
      name: 'create-store',
      partialize: (state) => ({
        mode: state.mode,
        imageModel: state.imageModel,
        imageModelType: state.imageModelType,
        videoModel: state.videoModel,
        sampler: state.sampler,
        scheduler: state.scheduler,
        steps: state.steps,
        cfgScale: state.cfgScale,
        width: state.width,
        height: state.height,
        batchSize: state.batchSize,
        frames: state.frames,
        fps: state.fps,
        denoise: state.denoise,
        gallery: state.gallery,
        promptHistory: state.promptHistory,
      }),
      // Migrate old 'i2i' mode to imageSubMode (v2.3.0 refactor)
      merge: (persisted: any, current: any) => {
        const merged = { ...current, ...persisted }
        if (merged.mode === 'i2i') {
          merged.mode = 'image'
          merged.imageSubMode = 'img2img'
        }
        return merged
      },
    }
  )
)
