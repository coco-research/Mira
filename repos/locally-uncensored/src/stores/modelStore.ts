import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import type { AIModel, PullProgress, ModelCategory } from '../types/models'
import { unloadModel } from '../api/ollama'
import { unloadLmStudioModel } from '../api/lmstudio'
import { isLmStudioProvider } from '../lib/hf-to-provider'
import { isTauri } from '../api/backend'
import { log } from '../lib/logger'

export interface PullState {
  progress: PullProgress
  controller: AbortController
  paused: boolean
  complete: boolean
}

interface ModelState {
  models: AIModel[]
  activeModel: string | null
  activePulls: Record<string, PullState>
  isModelLoading: boolean
  categoryFilter: ModelCategory
  setModels: (models: AIModel[]) => void
  setActiveModel: (name: string) => void
  startPull: (name: string, controller: AbortController) => void
  updatePullProgress: (name: string, progress: PullProgress) => void
  pausePull: (name: string) => void
  completePull: (name: string) => void
  dismissPull: (name: string) => void
  setIsModelLoading: (loading: boolean) => void
  setCategoryFilter: (category: ModelCategory) => void
}

export const useModelStore = create<ModelState>()(
  persist(
    (set, get) => ({
      models: [],
      activeModel: null,
      activePulls: {},
      isModelLoading: false,
      categoryFilter: 'all',

      setModels: (models) =>
        set((state) => {
          // Keep the persisted activeModel only if it's actually still
          // present in the freshly fetched list. Without this validation a
          // model name persists in the picker after the underlying provider
          // (e.g. Ollama) was uninstalled or the model was deleted — the
          // dropdown then shows a dead name and clicking it opens an empty
          // list. Falls back to the first available model, mirroring the
          // first-launch behavior so a user is never stuck with no
          // selection while a model exists.
          const stillValid = !!state.activeModel && models.some((m) => m.name === state.activeModel)
          return {
            models,
            activeModel: stillValid
              ? state.activeModel
              : (models.length > 0 ? models[0].name : null),
          }
        }),

      setActiveModel: (name) => {
        const prev = get().activeModel
        const prevModel = prev ? get().models.find((m) => m.name === prev) : undefined
        set({ activeModel: name })
        if (!prev || prev === name) return
        // Exactly ONE local model stays in VRAM at a time (David 2026-06-12:
        // "darf niemals 2 gleichzeitig geladen sein, außer man macht Compare").
        // Compare uses its own store + provider calls, NOT setActiveModel, so it
        // is unaffected. Unload the PREVIOUS local model via the right provider.
        //   - Ollama (no provider prefix)  → unloadModel
        //   - LM Studio (openai:: + LM-Studio providerName) → unloadLmStudioModel
        //   - Cloud (anthropic:: / OpenRouter / OpenAI etc.) → no local VRAM, skip
        // The old `!prev.includes('::')` guard skipped LM Studio entirely, so
        // switching AWAY from an LM Studio model left it loaded → two models in
        // VRAM at once. (David live find.)
        const prevIsLms = isLmStudioProvider(
          (prevModel && 'providerName' in prevModel && prevModel.providerName) as string | undefined,
        )
        if (prevIsLms) {
          const bareKey = prev.replace(/^[^:]+::/, '') // strip LU's routing prefix
          unloadLmStudioModel(bareKey).catch((e) =>
            log.warn('[modelStore] failed to unload previous LM Studio model', { model: prev, err: e }),
          )
        } else if (!prev.includes('::')) {
          unloadModel(prev).catch((e) =>
            log.warn('[modelStore] failed to unload previous model', { model: prev, err: e }),
          )
        }
      },

      startPull: (name, controller) =>
        set((state) => ({
          activePulls: {
            ...state.activePulls,
            [name]: { progress: { status: 'Starting download...' }, controller, paused: false, complete: false },
          },
        })),

      updatePullProgress: (name, progress) =>
        set((state) => {
          if (!state.activePulls[name]) return state
          return {
            activePulls: {
              ...state.activePulls,
              [name]: { ...state.activePulls[name], progress, paused: false },
            },
          }
        }),

      pausePull: (name) => {
        const pull = get().activePulls[name]
        if (pull && !pull.complete) {
          pull.controller.abort()
          set((state) => ({
            activePulls: {
              ...state.activePulls,
              [name]: { ...state.activePulls[name], paused: true, progress: { ...state.activePulls[name].progress, status: 'Paused' } },
            },
          }))
        }
      },

      completePull: (name) =>
        set((state) => {
          if (!state.activePulls[name]) return state
          return {
            activePulls: {
              ...state.activePulls,
              [name]: { ...state.activePulls[name], complete: true, paused: false, progress: { status: 'Complete' } },
            },
          }
        }),

      dismissPull: (name) => {
        // Bug #5 (phantomderp v2.4.3): the X-button used to remove the
        // entry from `activePulls` without telling Rust to stop the
        // underlying stream. The Tauri-side `pull_model_stream` kept
        // emitting `pull-progress` events that re-created the entry via
        // `pullModelTauri`'s listener — the item visually respawned within
        // 100 ms and the disk-write kept running. Fix: cancel both sides.
        //
        // 1. Abort the AbortController so the listener inside
        //    `useModels.pullModel` sees the abort and the controller's
        //    "abort" handler fires `cancel_model_pull`.
        // 2. Best-effort: invoke `cancel_model_pull` directly too. This
        //    covers the rare case where the controller was already
        //    consumed (e.g. completed-but-not-yet-dismissed entries) and
        //    is idempotent on the Rust side.
        const existing = get().activePulls[name]
        if (existing) {
          try { existing.controller.abort() } catch { /* already aborted */ }
        }
        if (isTauri()) {
          // Fire-and-forget — the Rust command returns Ok(()) even when
          // there's nothing to cancel, so failure here is non-fatal.
          import('@tauri-apps/api/core').then(({ invoke }) => {
            invoke('cancel_model_pull', { name }).catch(() => {})
          }).catch(() => {})
        }
        set((state) => {
          const { [name]: _, ...rest } = state.activePulls
          return { activePulls: rest }
        })
      },

      setIsModelLoading: (loading) => set({ isModelLoading: loading }),
      setCategoryFilter: (category) => set({ categoryFilter: category }),
    }),
    {
      name: 'chat-models',
      partialize: (state) => ({ activeModel: state.activeModel, categoryFilter: state.categoryFilter }),
    }
  )
)
