import { getImageModels, getVideoModels, isI2VModel, isT2VCapable } from './comfyui'
import type { ModelPickKind } from '../stores/modelPickStore'

/**
 * Model-Picker gate (v2.5.3). Runs inside executeImageGenerate /
 * executeVideoGenerate BEFORE vramHandoffGenerate — i.e. before the VRAM
 * swap — and returns the model name the generation should use, or null to
 * leave the existing auto-selection untouched. The pick is OURS (LU UI),
 * not the LLM's:
 *
 *   - explicit `model` arg from the user/LLM   → no picker (intent wins)
 *   - saved preference installed               → silent use (Change-Model
 *     affordance shows in the tool call instead)
 *   - nothing saved (or saved got uninstalled) → ModelPickerCard renders in
 *     the running tool call; save icon persists the choice for next prompts
 *   - ComfyUI unreachable / no models          → null (the existing decide
 *     phase reports its own actionable error — UX identical to before)
 *
 * Model filtering mirrors vram-handoff's decide phase exactly: image =
 * getImageModels; video splits by inputImage into I2V (isI2VModel) vs T2V
 * (the rest). The preference keys are per-kind because the sets are
 * disjoint (SVD can't T2V, Wan 1.3B can't I2V).
 */
export async function pickModelForGeneration(
  kind: 'image' | 'video',
  args: Record<string, any>,
): Promise<string | null> {
  if (typeof args.model === 'string' && args.model) return null

  // Same alias normalization as runHandoff — the pick must classify the call
  // the same way the decide phase will (input_image / image → inputImage).
  const inputImage = args.inputImage ?? args.input_image ?? args.image
  const wantI2V = kind === 'video' && typeof inputImage === 'string' && !!inputImage
  const pickKind: ModelPickKind = kind === 'image' ? 'image' : wantI2V ? 'video-i2v' : 'video-t2v'

  let names: string[]
  try {
    const models = kind === 'image' ? await getImageModels() : await getVideoModels()
    // T2V uses isT2VCapable (NOT !isI2VModel): Wan 2.2 TI2V is dual T2V/I2V,
    // so it must appear in BOTH picker lists — the old negation hid it from
    // the T2V picker (live find 2026-06-11, first wan22 T2V pick on the 3060).
    const eligible = kind === 'image'
      ? models
      : models.filter((m) => (wantI2V ? isI2VModel(m.name) : isT2VCapable(m.name)))
    names = eligible.map((m) => m.name)
  } catch {
    return null
  }
  if (names.length === 0) return null

  const { useSettingsStore } = await import('../stores/settingsStore')
  const prefKey =
    pickKind === 'image' ? 'preferredImageModel'
    : pickKind === 'video-t2v' ? 'preferredVideoT2VModel'
    : 'preferredVideoI2VModel'
  const saved = useSettingsStore.getState().settings[prefKey]
  if (saved && names.includes(saved)) return saved

  const { useModelPickStore } = await import('../stores/modelPickStore')
  const choice = await useModelPickStore.getState().request(pickKind, names, names[0])
  if (!choice) return names[0]
  if (choice.save) {
    useSettingsStore.getState().updateSettings({ [prefKey]: choice.model })
  }
  return choice.model
}
