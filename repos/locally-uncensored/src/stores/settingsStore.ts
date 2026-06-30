import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import type { Settings, Persona } from '../types/settings'
import { DEFAULT_SETTINGS, BUILT_IN_PERSONAS } from '../lib/constants'

// v5 (Feature EE v2.5.0): added settings.exclusiveVramMode. The migrate below
// already merges { ...DEFAULT_SETTINGS, ...persisted.settings }, so bumping the
// version is all that's needed — the new default fills in while every existing
// user value is preserved. Rehydration is NOT broken: a persisted v4 blob runs
// the same merge path that has handled every prior additive field.
// v6 (uselu design port): added settings.personasEnabled (master persona
// switch, default true). Bumped so existing users get the default ON instead
// of an undefined → falsy "personas off" surprise.
// v7 (Small-Model Mode v2.5.0): added settings.smallModelMode (lean profile
// for 3B-8B local models, default false). Same additive merge path below
// ({ ...DEFAULT_SETTINGS, ...persisted.settings }) fills the new default in
// while preserving every existing user value — existing users get it OFF.
// v8: added settings.userAvatarDataUrl (user profile picture, default ''),
// backfilled by the same additive merge — existing users keep the default icon.
// v9 (v2.5.3): added the model-picker preferences preferredImageModel /
// preferredVideoT2VModel / preferredVideoI2VModel (all default '' = "ask
// before the VRAM swap"). Same additive merge path — existing users simply
// see the picker on their next generation.
const STORE_VERSION = 9

interface SettingsState {
  settings: Settings
  personas: Persona[]
  activePersonaId: string
  _version: number
  updateSettings: (partial: Partial<Settings>) => void
  resetSettings: () => void
  /** GitHub #59 — reset only the given settings keys to their defaults
   *  (per-section reset; leaves everything else untouched). */
  resetSettingsKeys: (keys: (keyof Settings)[]) => void
  addPersona: (persona: Persona) => void
  removePersona: (id: string) => void
  updatePersona: (id: string, partial: Partial<Persona>) => void
  setActivePersona: (id: string) => void
  getActivePersona: () => Persona | undefined
}

export const useSettingsStore = create<SettingsState>()(
  persist(
    (set, get) => ({
      settings: DEFAULT_SETTINGS,
      personas: BUILT_IN_PERSONAS,
      activePersonaId: 'unrestricted',
      _version: STORE_VERSION,

      updateSettings: (partial) =>
        set((state) => ({ settings: { ...state.settings, ...partial } })),

      resetSettings: () => set((state) => ({ settings: { ...DEFAULT_SETTINGS, onboardingDone: state.settings.onboardingDone } })),

      resetSettingsKeys: (keys) =>
        set((state) => {
          const next = { ...state.settings }
          for (const k of keys) {
            // onboardingDone is a lifecycle marker, not a preference — never
            // reset it (same guard the full resetSettings applies).
            if (k === 'onboardingDone') continue
            ;(next as Record<string, unknown>)[k] = DEFAULT_SETTINGS[k]
          }
          return { settings: next }
        }),

      addPersona: (persona) =>
        set((state) => ({ personas: [...state.personas, persona] })),

      removePersona: (id) =>
        set((state) => ({
          personas: state.personas.filter((p) => p.id !== id),
          activePersonaId: state.activePersonaId === id ? 'unrestricted' : state.activePersonaId,
        })),

      updatePersona: (id, partial) =>
        set((state) => ({
          personas: state.personas.map((p) => (p.id === id ? { ...p, ...partial } : p)),
        })),

      setActivePersona: (id) => set({ activePersonaId: id }),

      getActivePersona: () => {
        const { personas, activePersonaId } = get()
        return personas.find((p) => p.id === activePersonaId)
      },
    }),
    {
      name: 'chat-settings',
      version: STORE_VERSION,
      migrate: (persisted: any, version: number) => {
        if (version < STORE_VERSION) {
          const customPersonas = (persisted.personas || []).filter((p: Persona) => !p.isBuiltIn)
          return {
            ...persisted,
            // Merge new default settings into existing (fills missing fields like thinkingEnabled)
            settings: { ...DEFAULT_SETTINGS, ...(persisted.settings || {}) },
            personas: [...BUILT_IN_PERSONAS, ...customPersonas],
            activePersonaId: persisted.activePersonaId || 'unrestricted',
            _version: STORE_VERSION,
          }
        }
        return persisted
      },
    }
  )
)
