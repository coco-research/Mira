/**
 * Feature EE (v2.5.0) — VRAM hand-off orchestrator for image/video generation.
 *
 * The problem: the local text model (Ollama) and the ComfyUI image/video model
 * both want the GPU. On a single-GPU machine with, say, 12 GB VRAM, a resident
 * 14 B chat model (~9 GB) plus a FLUX/Wan pipeline (~10 GB+) does not fit — the
 * second one to load OOMs. Pre-EE the agent's `image_generate` would just hand
 * the OOM straight back as "generation failed", which read as a broken feature.
 *
 * The fix: when (and ONLY when) the resident text model + the image/video
 * footprint won't co-exist, evict the text model from VRAM first, run the
 * generation, then reload the text model afterwards. The conversation itself
 * lives in chatStore and is never touched — unloading an Ollama model discards
 * only its KV cache (a one-message re-eval cost on the next turn), NOT any
 * message history. The LLM is stateless; "state preservation" here means we
 * never lose the chat, we just pay a small warm-up on the next reply.
 *
 * HONEST UX: this is an OOM-avoidance + state-preservation mechanism, NOT a
 * speed feature. A warm swap is ~30-90 s; a cold ComfyUI start is longer. The
 * VramSwitchCard + the tool descriptions say so plainly — we never imply a
 * zero-latency "seamless" experience.
 *
 * Sequence (vramHandoffGenerate):
 *   (a) DECIDE   — pure, no side effects. Resolve the target image/video model
 *                  and the text model to reload. Cloud/remote text models hold
 *                  no local VRAM → skip all juggling. decideUnload() does the
 *                  fits-or-not math, governed by settings.exclusiveVramMode.
 *   (b) HANDOFF-OUT — only when unloading: capture resident models, unload the
 *                  text model, then POLL /api/ps until it's actually gone (race
 *                  guard: do NOT start ComfyUI until Ollama confirms eviction).
 *   (c) GENERATE — start ComfyUI if needed (poll until up), build the workflow
 *                  (image: buildDynamicWorkflow; video: buildTxt2VidWorkflow),
 *                  submit, poll history, extract outputs. ComfyUI errors are
 *                  surfaced VERBATIM (an OOM must read as an OOM, not "failed").
 *   (d) HANDOFF-BACK — in `finally` (runs on success/failure/timeout): freeMemory
 *                  then best-effort loadModel(textModel) (non-fatal — Ollama
 *                  lazy-loads on the next message anyway).
 *   (e) RETURN   — the SAME string shape as the legacy image_generate so
 *                  ToolCallBlock renders it inline and useAgentChat feeds it
 *                  back to the model unchanged.
 *
 * A module-level in-flight mutex serialises calls so a 2nd generation awaits
 * the first — without it, the finally-reload of call #1 could fire mid-generation
 * of call #2 and re-trigger the exact OOM we are avoiding.
 */

import { backendCall, ollamaUrl, localFetch, isOllamaLocal } from './backend'
import { listRunningModels, loadModel, unloadModel } from './ollama'
import { useSettingsStore } from '../stores/settingsStore'
import {
  getImageModels,
  getVideoModels,
  detectVideoBackend,
  getSystemVRAM,
  submitWorkflow,
  getHistory,
  freeMemory,
  extractComfyOutputFiles,
  getImageUrl,
  classifyModel,
  isI2VModel,
  isT2VCapable,
  uploadImage,
  buildTxt2VidWorkflow,
  snapToVideoGrid,
  MODEL_TYPE_DEFAULTS,
  type VideoBackend,
} from './comfyui'
import type { ModelCapabilities } from './comfyui-nodes'
import { getActiveAgentModel } from './agent-context'
import { log } from '../lib/logger'

/**
 * Resolve a casual model name the user/LLM typed (e.g. "FramePack", "wan",
 * "sdxl") to an actually-installed model FILENAME. David 2026-06-04: no end user
 * types `FramePackI2V_HY_fp8_e4m3fn.safetensors`. Tries, in order: normalized
 * exact match, requested-is-substring-of-model, model-is-substring, then token
 * overlap. Returns null when nothing matches confidently, so the caller reports
 * it instead of silently generating with the wrong model.
 */
export function resolveModelName(
  requested: string,
  installed: { name: string }[],
): string | null {
  const norm = (s: string) =>
    s.toLowerCase().replace(/\.(safetensors|ckpt|pt|pth|gguf|sft|bin)$/i, '').replace(/[^a-z0-9]+/g, '')
  const r = norm(requested)
  if (!r || installed.length === 0) return null
  // 1) exact normalized filename match
  let hit = installed.find((m) => norm(m.name) === r)
  if (hit) return hit.name
  // 2) casual name contained in a model filename ("framepack" → "framepacki2v…")
  hit = installed.find((m) => norm(m.name).includes(r))
  if (hit) return hit.name
  // 3) a model filename contained in the (longer) requested string
  hit = installed.find((m) => norm(m.name).length >= 3 && r.includes(norm(m.name)))
  if (hit) return hit.name
  // 4) token overlap — most request words appear in the model filename
  const tokens = requested.toLowerCase().split(/[^a-z0-9]+/).filter((t) => t.length > 2)
  let best: { name: string } | null = null
  let bestScore = 0
  for (const m of installed) {
    const mn = norm(m.name)
    const score = tokens.filter((t) => mn.includes(t)).length
    if (score > bestScore) { bestScore = score; best = m }
  }
  return best && bestScore > 0 ? best.name : null
}

export type HandoffPhase =
  | 'deciding'
  | 'freeing_vram'
  | 'loading_image_model'
  | 'generating'
  | 'restoring_text'
  | 'done'
  | 'error'

export interface HandoffEventDetail {
  phase: HandoffPhase
  /** 'image' | 'video' — which generation kind is in flight. */
  kind?: 'image' | 'video'
  /** Free-text detail for the card (e.g. a model name or an error message). */
  detail?: string
  /** True only on the final 'done'/'error' so the card knows to fade out. */
  terminal?: boolean
}

// ── Status channel (pure TS, no Rust round-trip) ──────────────────
//
// A tiny browser EventTarget the orchestrator pushes phase events onto. The
// VramSwitchCard subscribes via useVramHandoff. Emitting is best-effort and
// NEVER throws — in a non-DOM context (vitest node env) `EventTarget` may be
// unavailable, so we guard creation and swallow any failure. The orchestrator
// must keep working with or without a UI listening.

export const HANDOFF_EVENT = 'lu-vram-handoff'

let _channel: EventTarget | null = null
function getChannel(): EventTarget | null {
  if (_channel) return _channel
  try {
    if (typeof EventTarget !== 'undefined') {
      _channel = new EventTarget()
      return _channel
    }
  } catch { /* no EventTarget in this runtime */ }
  return null
}

/** Subscribe to hand-off phase events. Returns an unsubscribe fn (no-op if unavailable). */
export function onHandoff(listener: (d: HandoffEventDetail) => void): () => void {
  const ch = getChannel()
  if (!ch) return () => {}
  const wrapped = (e: Event) => {
    const detail = (e as CustomEvent<HandoffEventDetail>).detail
    if (detail) listener(detail)
  }
  ch.addEventListener(HANDOFF_EVENT, wrapped as EventListener)
  return () => ch.removeEventListener(HANDOFF_EVENT, wrapped as EventListener)
}

/** Emit a phase event. No-throw — a failed emit must never break a generation. */
function emitHandoff(phase: HandoffPhase, opts?: Omit<HandoffEventDetail, 'phase'>): void {
  try {
    const ch = getChannel()
    if (!ch) return
    const terminal = phase === 'done' || phase === 'error'
    const evt = new CustomEvent<HandoffEventDetail>(HANDOFF_EVENT, {
      detail: { phase, terminal, ...opts },
    })
    ch.dispatchEvent(evt)
  } catch { /* best effort */ }
}

// ── Resident-model VRAM probe (/api/ps) ───────────────────────────
//
// listRunningModels() in ollama.ts throws away the per-model sizes, but the
// fits-or-not decision needs `size_vram` (bytes of the model actually resident
// in GPU memory). So we hit /api/ps directly here, mirroring that function's
// transport + soft-fail-to-empty behaviour.

interface ResidentModel {
  name: string
  /** Bytes of this model currently resident in VRAM (0 if CPU-only / unknown). */
  sizeVram: number
}

async function getResidentModels(): Promise<ResidentModel[]> {
  try {
    // Short cap: /api/ps is a quick status read. Bounding it keeps the DECIDE
    // phase from inheriting the proxy's 5-min default if Ollama is wedged.
    const res = await localFetch(ollamaUrl('/ps'), { timeoutMs: 8_000 })
    if (!res.ok) return []
    const data = await res.json()
    return (data.models || []).map((m: any) => ({
      name: m.name || m.model || '',
      sizeVram: typeof m.size_vram === 'number' ? m.size_vram : 0,
    }))
  } catch {
    return []
  }
}

// ── Footprint estimate for the image/video model ──────────────────
//
// We don't know the exact runtime VRAM a ComfyUI pipeline will take before we
// run it (it depends on resolution, dtype, the VAE, text encoder, etc.), so we
// use a conservative per-architecture estimate in GB. The number is the
// *checkpoint/diffusion + typical aux* footprint — deliberately on the high
// side so 'auto' errs toward freeing rather than toward an OOM. These are
// estimates, not measurements (Bug-G lesson: only live E2E confirms the real
// number on a given GPU); they exist solely to make the fits/doesn't-fit
// comparison meaningful, never to gate the generation hard.
const MODEL_FOOTPRINT_GB: Record<string, number> = {
  // Image
  sd15: 4,
  sdxl: 8,
  flux: 16,
  flux2: 22,
  zimage: 12,
  ernie_image: 18,
  // Video (heavier — UNet + VAE + big text encoder all resident)
  wan: 18,
  hunyuan: 20,
  ltx: 12,
  mochi: 22,
  cosmos: 24,
  cogvideo: 18,
  svd: 12,
  framepack: 18,
  pyramidflow: 16,
  allegro: 20,
}

/** Best-effort footprint for a model name. Unknown → null (caller treats as unknown). */
export function estimateModelFootprintGB(modelName: string): number | null {
  const type = classifyModel(modelName)
  return MODEL_FOOTPRINT_GB[type] ?? null
}

export type ExclusiveVramMode = 'auto' | 'always' | 'never'

export interface DecideUnloadInput {
  /** Bytes of text model currently resident in VRAM (from /api/ps size_vram). 0/undefined = unknown. */
  textVramBytes: number | undefined
  /** Estimated image/video footprint in GB (from estimateModelFootprintGB). null = unknown. */
  modelFootprintGB: number | null
  /** Total system VRAM in GB (from getSystemVRAM). null = unknown. */
  systemVramGB: number | null
  /** Governing setting. */
  mode: ExclusiveVramMode
}

export interface DecideUnloadResult {
  unload: boolean
  reason: string
}

const BYTES_PER_GB = 1024 * 1024 * 1024

// Fallback FramePack frame ceiling. FramePack is duration-driven (total_second_length),
// so /object_info exposes no per-model frame max — getModelCapabilities() returns this
// same 600 for framepack, and generateVideo passes it as resolveClip's maxFrames fallback
// when capabilities are unavailable. Guards a typo'd seconds×fps from queuing an
// hours-long render. ~15 s @ 40 fps / ~37 s @ 16 fps.
const FRAMEPACK_MAX_FRAMES = 600

/**
 * Pure decision: should we evict the text model before generating?
 *
 *   - mode 'never'  → never unload (user opted out of juggling).
 *   - mode 'always' → always unload when there IS a resident text model.
 *   - mode 'auto'   → unload only when the math says they won't co-exist:
 *                     (textVram + footprint) > systemVram. If ANY input is
 *                     unknown we DON'T unload — better to attempt the gen and
 *                     surface a real OOM than to evict the user's model on a
 *                     guess (the unload itself costs a re-eval next turn).
 *
 * Exported + side-effect-free so the unit tests can exhaustively cover the
 * fits / doesn't-fit / unknown matrix without any live services.
 */
export function decideUnload(input: DecideUnloadInput): DecideUnloadResult {
  const { textVramBytes, modelFootprintGB, systemVramGB, mode } = input

  if (mode === 'never') {
    return { unload: false, reason: 'exclusiveVramMode=never' }
  }

  const textGB = textVramBytes && textVramBytes > 0 ? textVramBytes / BYTES_PER_GB : 0

  if (mode === 'always') {
    // Only meaningful to unload if the text model is actually resident in VRAM.
    if (textGB > 0) return { unload: true, reason: 'exclusiveVramMode=always (text model resident)' }
    return { unload: false, reason: 'exclusiveVramMode=always but no text model resident in VRAM' }
  }

  // mode === 'auto'
  if (textGB <= 0) {
    return { unload: false, reason: 'auto: no text model resident in VRAM (nothing to free)' }
  }
  if (modelFootprintGB == null || systemVramGB == null) {
    // Unknown sizes → don't unload on auto. Attempt the gen; if it OOMs the
    // user sees the verbatim ComfyUI error and can switch to 'always'.
    return { unload: false, reason: 'auto: unknown footprint or system VRAM — not unloading on a guess' }
  }
  const needed = textGB + modelFootprintGB
  if (needed > systemVramGB) {
    return {
      unload: true,
      reason: `auto: text ${textGB.toFixed(1)}GB + model ${modelFootprintGB}GB = ${needed.toFixed(1)}GB > ${systemVramGB}GB VRAM`,
    }
  }
  return {
    unload: false,
    reason: `auto: text ${textGB.toFixed(1)}GB + model ${modelFootprintGB}GB = ${needed.toFixed(1)}GB fits in ${systemVramGB}GB VRAM`,
  }
}

// ── ComfyUI lifecycle helpers ─────────────────────────────────────

interface ComfyStatus {
  running?: boolean
  starting?: boolean
  found?: boolean
}

async function comfyIsRunning(): Promise<boolean> {
  try {
    const s = await backendCall<ComfyStatus>('comfyui_status')
    return !!s?.running
  } catch {
    return false
  }
}

/**
 * Ensure ComfyUI is up. If `comfyui_status` already reports running, return
 * immediately. Otherwise fire `start_comfyui` and poll status until running or
 * the cold-start budget (~90 s) elapses. Non-fatal: returns false on timeout so
 * the caller can still attempt the workflow (the submit will surface a clear
 * connection error if ComfyUI truly never came up).
 */
async function ensureComfyRunning(timeoutMs = 90_000): Promise<boolean> {
  if (await comfyIsRunning()) return true
  try {
    await backendCall('start_comfyui')
  } catch (e) {
    log.warn('vram_handoff.start_comfyui_failed', { err: String(e) })
    // Fall through to poll anyway — it may already be starting.
  }
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    await sleep(1500)
    if (await comfyIsRunning()) return true
  }
  return false
}

/**
 * Race guard: after unloadModel(textModel), poll /api/ps until that model is no
 * longer resident (or timeout). Starting ComfyUI before Ollama has actually
 * released the VRAM defeats the whole point — the two would briefly co-exist
 * and OOM. 15 s is generous; a `keep_alive:0` evict is usually sub-second.
 */
// ── LM Studio text-model juggling (v2.5.3) ───────────────────────

export interface LmsTextModel {
  /** Bare LM Studio model id (no `openai::` routing prefix). */
  id: string
  /** Context length it was loaded with — restored on reload via `lms load -c`. */
  contextLength: number | null
}

/** Empirically detect whether the active 'openai' provider model is a LOCAL
 *  LM Studio model currently holding VRAM. Asks the local LM Studio REST
 *  (lmstudio_model_context → state === 'loaded'); anything else — cloud
 *  OpenAI, other openai-compat endpoints, LM Studio not running — returns
 *  null and the orchestrator skips juggling exactly as before. */
export async function detectLmsTextModel(
  active: { name: string; providerId: string } | null,
): Promise<LmsTextModel | null> {
  if (!active || active.providerId !== 'openai' || !active.name) return null
  const bare = active.name.startsWith('openai::')
    ? active.name.slice('openai::'.length)
    : active.name
  try {
    const info = await backendCall<{ loaded: number | null; state: string | null }>(
      'lmstudio_model_context',
      { model: bare },
    )
    if (info && info.state === 'loaded') {
      return { id: bare, contextLength: typeof info.loaded === 'number' ? info.loaded : null }
    }
  } catch { /* LM Studio absent → no local VRAM held */ }
  return null
}

/** Live-truth fallback (v2.5.3 follow-up): whatever the LOCAL LM Studio REST
 *  reports as loaded holds VRAM — regardless of which provider the chat uses
 *  or whether the agent-loop pin survived (rolldown chunk duplication ate it
 *  in the release build, and Codex never pinned). Returns the first loaded
 *  model with its loaded context length, or null when LM Studio is absent /
 *  nothing is loaded. */
export async function detectAnyLoadedLmsModel(): Promise<LmsTextModel | null> {
  try {
    const list = await backendCall<{ loaded: string[] }>('lmstudio_list_loaded', {})
    const id = Array.isArray(list?.loaded) ? list.loaded.find((m) => typeof m === 'string' && m) : undefined
    if (!id) return null
    let contextLength: number | null = null
    try {
      const info = await backendCall<{ loaded: number | null }>('lmstudio_model_context', { model: id })
      contextLength = typeof info?.loaded === 'number' ? info.loaded : null
    } catch { /* context unknown — reload without -c */ }
    return { id, contextLength }
  } catch {
    return null
  }
}

/** Pure pick: which resident Ollama model is the evict-then-reload target?
 *  The pinned agent-loop model wins when it is actually resident; otherwise
 *  the largest resident one (in practice: the chat model). Exported for the
 *  unit tests — the live-state fallback this feeds exists because the pin
 *  alone proved unreliable (chunk duplication / unpinned callers). */
export function pickResidentOllamaTarget(
  resident: { name: string; sizeVram?: number }[],
  active: { name: string; providerId: string; remote: boolean } | null,
): { name: string; sizeVram?: number } | null {
  if (resident.length === 0) return null
  const preferred =
    active && active.providerId === 'ollama' && active.remote === false
      ? resident.find((m) => m.name === active.name)
      : undefined
  return (
    preferred ??
    resident.reduce((a, b) => (((b.sizeVram ?? 0) > (a.sizeVram ?? 0)) ? b : a))
  )
}

/** Rough VRAM estimate for an LM Studio text model from its id's parameter
 *  count ("…-7b…" → ~5.3 GB at Q4 + context overhead). LM Studio's REST has
 *  no VRAM figure, so this feeds decideUnload the same way Ollama's
 *  sizeVram does; no parseable size → undefined → safe no-evict in 'auto'. */
export function estimateLmsTextVramBytes(id: string): number | undefined {
  const m = id.toLowerCase().match(/(\d+(?:\.\d+)?)\s*b\b/)
  if (!m) return undefined
  const params = parseFloat(m[1])
  if (!Number.isFinite(params) || params <= 0) return undefined
  return Math.round(params * 0.75 * 1e9)
}

export async function pollGone(modelName: string, timeoutMs = 15_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  // Check immediately first (cheap) before sleeping.
  for (;;) {
    let running: string[]
    try {
      running = await listRunningModels()
    } catch {
      running = []
    }
    if (!running.includes(modelName)) return true
    if (Date.now() >= deadline) return false
    await sleep(750)
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

// ── In-flight mutex ───────────────────────────────────────────────
//
// One generation at a time. A 2nd call chains onto the 1st's promise so the
// reload-in-finally of call #1 can never overlap the generate of call #2.
let _inFlight: Promise<unknown> = Promise.resolve()

// Last image LU actually produced this session. Small models routinely pass a
// hallucinated filename (e.g. "locally_saved_image.png") to a follow-up
// video_generate; when the given name can't be resolved we fall back to this so
// the "animate the image you just made" chain still works. Set after each
// successful image generation.
let _lastImageFilename: string | null = null

// ── Public orchestrator ───────────────────────────────────────────

export interface VramHandoffArgs {
  prompt?: string
  negativePrompt?: string
  model?: string
  // Image-to-image / image-to-video: a filename from a prior generate result.
  inputImage?: string
  // Image-to-image denoise strength (0.05–1.0).
  denoise?: number
  // Video-only
  frames?: number
  fps?: number
  // Desired clip length in seconds. Preferred over raw frames for the agent —
  // LU converts it to frames/fps per model (honoring the duration even when a
  // model like SVD caps the frame count).
  seconds?: number
  [k: string]: unknown
}

/**
 * Orchestrate one image/video generation with VRAM hand-off. Always resolves to
 * a result string (never rejects) so the agent loop gets a clean tool message.
 */
export async function vramHandoffGenerate(kind: 'image' | 'video', args: VramHandoffArgs): Promise<string> {
  // Serialise. We park on the previous call's settled promise (success OR
  // failure — `.catch` swallows so a prior error doesn't reject our chain),
  // then run our own body and expose it as the new tail.
  const run = _inFlight
    .catch(() => {})
    .then(() => runHandoff(kind, args))
    // Defensive: runHandoff is written to always RETURN a string (the finally
    // block never rethrows), but if anything unexpected slips through we still
    // hand the agent a clean tool message instead of rejecting the chain.
    .catch((e) => `${kind === 'video' ? 'Video' : 'Image'} generation failed: ${e instanceof Error ? e.message : String(e)}`)
  _inFlight = run.catch(() => {})
  return run
}

async function runHandoff(kind: 'image' | 'video', args: VramHandoffArgs): Promise<string> {
  // Robustness for small local models (gemma4:e4b live): they frequently emit a
  // snake_case `input_image` alias and sometimes omit `prompt` on a video call.
  // Normalize the alias so the I2V path still finds the source image.
  if (args.inputImage == null) {
    const alt = (args as Record<string, unknown>).input_image ?? (args as Record<string, unknown>).image
    if (typeof alt === 'string' && alt) args.inputImage = alt
  }
  // Duration alias: models say duration / length / durationSeconds for `seconds`
  // (gemma4 live passed {"duration": 4}). Normalize so resolveClip honors it.
  if (args.seconds == null) {
    const d = (args as Record<string, unknown>).duration ?? (args as Record<string, unknown>).length ?? (args as Record<string, unknown>).durationSeconds
    const n = typeof d === 'number' ? d : Number(d)
    if (Number.isFinite(n) && n > 0) args.seconds = n
  }
  let prompt = String(args.prompt ?? args.description ?? '').trim()
  if (!prompt) {
    // A video call (esp. image-to-video / SVD) can animate without an explicit
    // prompt — default a gentle motion rather than hard-failing on "prompt
    // required" (which made gemma give up mid-chain). Images still need a prompt.
    if (kind === 'video') prompt = 'gentle, subtle natural motion'
    else return `Error: No prompt provided for ${kind} generation.`
  }

  emitHandoff('deciding', { kind })

  // ── (a) DECIDE — resolve target model (no side effects yet) ──────
  let targetModel: string
  let videoBackend: VideoBackend = 'none'
  try {
    if (kind === 'image') {
      const models = await getImageModels()
      if (models.length === 0) {
        emitHandoff('error', { kind, detail: 'no image model installed' })
        return 'Error: No image model installed. Download one from Models → Discover (e.g. "FLUX.1 [schnell] FP8", "Z-Image Turbo", or "Juggernaut XL V9") and try again.'
      }
      if (typeof args.model === 'string' && args.model) {
        const resolved = resolveModelName(args.model, models)
        if (!resolved) {
          emitHandoff('error', { kind, detail: 'model not found' })
          return `Error: No installed image model matches "${args.model}". Installed: ${models.map((m) => m.name).join(', ')}. Try one of those names (a partial name like "FLUX" or "SDXL" works).`
        }
        targetModel = resolved
      } else {
        targetModel = models[0].name
      }
    } else {
      const [models, backend] = await Promise.all([getVideoModels(), detectVideoBackend()])
      const wantI2V = typeof args.inputImage === 'string' && !!args.inputImage
      if (wantI2V) {
        // Image-to-video needs an I2V-capable model (SVD / FramePack). Those use
        // built-in ComfyUI nodes, so a 'none' text-to-video backend is fine here.
        const i2vModels = models.filter((m) => isI2VModel(m.name))
        if (i2vModels.length === 0) {
          emitHandoff('error', { kind, detail: 'no i2v model installed' })
          return 'Error: Image-to-video needs an I2V model such as SVD. Install one from Models → Discover (e.g. "SVD-XT 1.1 — Image to Video"), then try again.'
        }
        if (typeof args.model === 'string' && args.model) {
          const resolved = resolveModelName(args.model, i2vModels)
          if (!resolved) {
            emitHandoff('error', { kind, detail: 'i2v model not found' })
            return `Error: No installed image-to-video model matches "${args.model}". Installed I2V: ${i2vModels.map((m) => m.name).join(', ')}. A partial name like "SVD" or "FramePack" works.`
          }
          targetModel = resolved
        } else {
          targetModel = i2vModels[0].name
        }
        videoBackend = backend
      } else {
        // Text-to-video must NOT pick an image-to-video-ONLY checkpoint (SVD /
        // FramePack) — those load via ImageOnlyCheckpointLoader, so feeding one
        // into a Wan/UNet T2V workflow yields ComfyUI "UNETLoader: value not in
        // list" (gemma4 live, scenario 3c). isT2VCapable keeps Wan 2.2 TI2V (dual
        // T2V/I2V) in the list while still excluding the I2V-only checkpoints.
        const t2vModels = models.filter((m) => isT2VCapable(m.name))
        if (t2vModels.length === 0 || backend === 'none') {
          emitHandoff('error', { kind, detail: 'no text-to-video model installed' })
          return 'Error: No text-to-video model installed. Download one from Models → Discover (e.g. "Wan 2.1 — 1.3B (Lightweight)" for 8-10 GB VRAM or "HunyuanVideo 1.5 T2V FP8" for 12+ GB) — or generate an image first and animate it with an I2V model like "SVD-XT 1.1".'
        }
        if (typeof args.model === 'string' && args.model) {
          const resolved = resolveModelName(args.model, t2vModels)
          if (!resolved) {
            emitHandoff('error', { kind, detail: 't2v model not found' })
            return `Error: No installed text-to-video model matches "${args.model}". Installed T2V: ${t2vModels.map((m) => m.name).join(', ')}. A partial name like "Wan" or "Hunyuan" works.`
          }
          targetModel = resolved
        } else {
          targetModel = t2vModels[0].name
        }
        videoBackend = backend
      }
    }
  } catch (e) {
    // ComfyUI unreachable while listing models — we have not unloaded anything,
    // so just report it. Don't mask the connection failure.
    emitHandoff('error', { kind, detail: String(e) })
    return `Error: Could not query ComfyUI models — ${e instanceof Error ? e.message : String(e)}. Is ComfyUI installed and reachable?`
  }

  // Which text model do we reload afterwards? The pinned agent-loop model is
  // the PREFERENCE — but the pin has proven fragile in the wild (the rolldown
  // build duplicated agent-context so the pin read null in the release app,
  // and Codex never pinned at all; live E2E 2026-06-11). What actually holds
  // VRAM is authoritative, so the decision now starts from the LIVE state:
  // /api/ps for a local Ollama, the LM Studio REST for a local LM Studio.
  // Cloud providers / remote bases never show up in either probe, so they
  // skip juggling exactly as before.
  const active = getActiveAgentModel()

  // ── Ollama side (live): resident models from /api/ps ──────────────
  let textModel: string | null = null
  let textVramBytes: number | undefined
  if (isOllamaLocal()) {
    try {
      const resident = await getResidentModels()
      const candidate = pickResidentOllamaTarget(resident, active)
      if (candidate) {
        textModel = candidate.name
        textVramBytes = candidate.sizeVram
      }
    } catch {
      // /api/ps unreachable → treat as nothing resident (no Ollama to juggle).
    }
  }

  // ── LM Studio side (live): pinned context first, then list_loaded ──
  // detectLmsTextModel covers the pinned 'openai' chat model; the fallback
  // covers everything the pin misses (Codex, cloud chat with a stray loaded
  // LMS model, lost pin). Both only ever match the LOCAL LM Studio REST.
  let lmsTarget = await detectLmsTextModel(active)
  if (!lmsTarget) lmsTarget = await detectAnyLoadedLmsModel()
  const lmsVramBytes = lmsTarget ? estimateLmsTextVramBytes(lmsTarget.id) : undefined

  // ── Decide: one shared fits/doesn't-fit call over EVERYTHING resident.
  // If the sum doesn't co-exist with the generation footprint, free BOTH
  // sides — over-evicting is lossless (both reload in the finally), while
  // under-evicting risks the exact 11.9/12 GB thrash this exists to avoid.
  let willUnload = false
  let willUnloadLms = false
  if (textModel || lmsTarget) {
    try {
      const [footprint, systemVram, mode] = await Promise.all([
        Promise.resolve(estimateModelFootprintGB(targetModel)),
        getSystemVRAM(),
        Promise.resolve(getExclusiveVramMode()),
      ])
      const residentBytes = (textVramBytes ?? 0) + (lmsVramBytes ?? 0)
      const decision = decideUnload({
        textVramBytes: residentBytes > 0 ? residentBytes : undefined,
        modelFootprintGB: footprint,
        systemVramGB: systemVram,
        mode,
      })
      willUnload = decision.unload && !!textModel
      willUnloadLms = decision.unload && !!lmsTarget
      log.info('vram_handoff.decision', {
        kind,
        targetModel,
        textModel,
        lmsModel: lmsTarget?.id ?? null,
        textVramBytes,
        lmsVramBytes,
        ...decision,
      })
    } catch (e) {
      // Decision probe failed — default to NOT unloading (safer; attempt gen).
      log.warn('vram_handoff.decision_failed', { err: String(e) })
      willUnload = false
      willUnloadLms = false
    }
  }

  // Capture resident text models BEFORE unload so the reload target is honest
  // even if `active` was somehow stale.
  let evictedModel: string | null = null
  let evictedLms: LmsTextModel | null = null

  try {
    // ── (b) HANDOFF-OUT — only if we decided to unload ─────────────
    if (willUnload && textModel) {
      emitHandoff('freeing_vram', { kind, detail: textModel })
      // Confirm it's actually resident right now (capture-before-unload).
      let runningBefore: string[]
      try {
        runningBefore = await listRunningModels()
      } catch {
        runningBefore = []
      }
      if (runningBefore.includes(textModel)) {
        try {
          await unloadModel(textModel)
          evictedModel = textModel
        } catch (e) {
          // Unload failed — don't block the gen, but log. ComfyUI may still OOM;
          // that error will surface verbatim below.
          log.warn('vram_handoff.unload_failed', { textModel, err: String(e) })
        }
        // RACE GUARD: wait until /api/ps confirms eviction before touching ComfyUI.
        if (evictedModel) {
          const gone = await pollGone(evictedModel)
          if (!gone) {
            log.warn('vram_handoff.evict_timeout', { textModel: evictedModel })
          }
        }
      }
    }

    // ── (b2) HANDOFF-OUT for a local LM Studio text model ──────────
    if (willUnloadLms && lmsTarget) {
      emitHandoff('freeing_vram', { kind, detail: lmsTarget.id })
      try {
        await backendCall('lmstudio_unload_model', { model: lmsTarget.id })
        evictedLms = lmsTarget
        // Race guard, mirroring pollGone: wait until the REST stops reporting
        // 'loaded' before ComfyUI starts grabbing VRAM.
        for (let i = 0; i < 10; i++) {
          const info = await backendCall<{ state: string | null }>(
            'lmstudio_model_context',
            { model: lmsTarget.id },
          ).catch(() => null)
          if (!info || info.state !== 'loaded') break
          await new Promise((r) => setTimeout(r, 1000))
        }
      } catch (e) {
        // Same policy as the Ollama path: never block the generation on a
        // failed unload — ComfyUI may still OOM and that surfaces verbatim.
        log.warn('vram_handoff.lms_unload_failed', { lmsModel: lmsTarget.id, err: String(e) })
      }
    }

    // ── (c) GENERATE ───────────────────────────────────────────────
    emitHandoff('loading_image_model', { kind, detail: targetModel })
    const up = await ensureComfyRunning()
    if (!up) {
      // Surface clearly; the finally block still restores the text model.
      emitHandoff('error', { kind, detail: 'ComfyUI did not start' })
      return 'Error: ComfyUI did not start within 90s. Start it from the Create tab and try again.'
    }

    emitHandoff('generating', { kind, detail: targetModel })

    const result = kind === 'image'
      ? await generateImage(prompt, targetModel, args)
      : await generateVideo(prompt, targetModel, videoBackend, args)
    return result
  } finally {
    // ── (d) HANDOFF-BACK — ALWAYS (success, failure, timeout) ──────
    // Free ComfyUI's VRAM first (so the text model has room to reload), then
    // best-effort reload the text model. The reload is non-fatal: if it throws,
    // Ollama will lazy-load on the user's next message anyway.
    emitHandoff('restoring_text', { kind, detail: evictedModel ?? evictedLms?.id ?? undefined })
    try {
      await freeMemory()
    } catch { /* best effort */ }
    if (evictedModel) {
      try {
        await loadModel(evictedModel)
      } catch (e) {
        log.warn('vram_handoff.reload_failed', { textModel: evictedModel, err: String(e) })
      }
    }
    if (evictedLms) {
      try {
        // Restore with the SAME context length it was loaded with (the REST
        // reported it at detect time) — `lms load` without -c would fall back
        // to the model default and silently shrink long chats.
        await backendCall('lmstudio_load_model', {
          model: evictedLms.id,
          ...(evictedLms.contextLength ? { contextLength: evictedLms.contextLength } : {}),
        })
      } catch (e) {
        log.warn('vram_handoff.lms_reload_failed', { lmsModel: evictedLms.id, err: String(e) })
      }
    }
    emitHandoff('done', { kind })
  }
}

// ── Generation bodies ─────────────────────────────────────────────

/** Image path — mirrors the legacy executeImageGenerate, via buildDynamicWorkflow. */
async function generateImage(prompt: string, model: string, args: VramHandoffArgs): Promise<string> {
  const { buildDynamicWorkflow } = await import('./dynamic-workflow')
  try {
    // Capability-aware: read this model's REAL limits/enums from ComfyUI and
    // REJECT (not clamp) any explicit user value beyond them (decision 2).
    const caps = await fetchCaps(model, 'image')
    const tun = resolveTunables(args, caps, { steps: 20, cfg: 7, sampler: 'euler', scheduler: 'normal' })
    if (tun.reject) return `Cannot generate: ${tun.reject}`

    const a = args as Record<string, unknown>
    const width = clampInt(a.width, 1024, 64, 4096)
    const height = clampInt(a.height, 1024, 64, 4096)
    const seed = (typeof a.seed === 'number' && Number.isFinite(a.seed)) ? Math.floor(a.seed) : -1
    const batchSize = clampInt(a.batchSize ?? a.batch_size, 1, 1, 8)

    // Image-to-image: resolve the referenced output image into ComfyUI's input
    // folder, then let buildDynamicWorkflow wire LoadImage → VAEEncode + denoise.
    let inputImage: string | undefined
    let denoise: number | undefined
    if (typeof args.inputImage === 'string' && args.inputImage) {
      inputImage = (await resolveInputImage(args.inputImage)).name
      denoise = clampFloat(args.denoise, 0.6, 0.05, 1.0)
    }
    const workflow = await buildDynamicWorkflow(
      {
        prompt,
        negativePrompt: typeof args.negativePrompt === 'string' ? args.negativePrompt : '',
        model,
        sampler: tun.sampler,
        scheduler: tun.scheduler,
        steps: tun.steps,
        cfgScale: tun.cfg,
        width,
        height,
        seed,
        batchSize,
        // Multi-LoRA (konata): accept a single name, an array, or a comma-
        // joined string; same for strengths. buildDynamicWorkflow normalizes
        // and chains them — invalid shapes are simply dropped here.
        ...(typeof a.lora === 'string' && a.lora
          ? { lora: a.lora as string }
          : Array.isArray(a.lora) && (a.lora as unknown[]).some((x) => typeof x === 'string' && x)
            ? { lora: (a.lora as unknown[]).filter((x): x is string => typeof x === 'string' && !!x) }
            : {}),
        ...(typeof a.loraStrength === 'number'
          ? { loraStrength: a.loraStrength as number }
          : Array.isArray(a.loraStrength) && (a.loraStrength as unknown[]).some((x) => typeof x === 'number')
            ? { loraStrength: (a.loraStrength as unknown[]).filter((x): x is number => typeof x === 'number') }
            : {}),
        ...(typeof a.vae === 'string' && a.vae ? { vae: a.vae as string } : {}),
        ...(typeof a.clipSkip === 'number' ? { clipSkip: a.clipSkip as number } : {}),
        ...(inputImage ? { inputImage, denoise } : {}),
      },
      classifyModel(model),
    )
    // Phase markers (chat-agent hang 2026-06-03): make it obvious in the log
    // whether a stall is in the workflow build (/object_info) or the submit
    // (/prompt). Both are now timeout-bounded, so neither can strand the
    // hand-off with the text model unloaded — these logs just pinpoint where.
    log.info('vram_handoff.image.submit', { model, i2i: !!inputImage })
    const promptId = await submitWorkflow(workflow)
    log.info('vram_handoff.image.submitted', { promptId })
    const result = await pollAndExtract(promptId, prompt, label('image'), getImageTimeoutMs())
    // Remember the produced filename so a follow-up "animate it" video call can
    // fall back to it when the model passes a wrong/hallucinated inputImage.
    const fn = result.match(/generated:\s*([^\s(]+\.(?:png|jpe?g|webp))/i)
    if (fn) _lastImageFilename = fn[1]
    return result
  } catch (err) {
    // Surface ComfyUI's message verbatim — an OOM must NOT be masked.
    return `${label('image')} generation failed: ${err instanceof Error ? err.message : String(err)}`
  }
}

/** Video path — buildTxt2VidWorkflow with MODEL_TYPE_DEFAULTS + snapToVideoGrid. */
async function generateVideo(
  prompt: string,
  model: string,
  backend: VideoBackend,
  args: VramHandoffArgs,
): Promise<string> {
  try {
    const type = classifyModel(model)
    // Capability-aware (decision 2): real per-model limits/enums from ComfyUI.
    const caps = await fetchCaps(model, 'video')

    // ── Wan 2.2 TI2V-5B: one model, both modes ─────────────────────
    // Wan22ImageToVideoLatent takes an OPTIONAL start_image, so a single dynamic
    // path serves text-to-video (no still) AND image-to-video (still → the clip
    // opens on it). Handle it HERE, before the SVD/FramePack I2V branch — wan22 now
    // matches isI2VModel(), but that branch's 25-frame / 8-fps tuning would butcher
    // it (wan22 is 24 fps, up to ~7 s). buildDynamicWorkflow routes to buildWan22.
    if (type === 'wan22') {
      const { buildDynamicWorkflow } = await import('./dynamic-workflow')
      const d = MODEL_TYPE_DEFAULTS.wan22
      const av = args as Record<string, unknown>

      // Optional source still (I2V). A wrong/hallucinated name falls back to the
      // last image LU produced this session — same recovery as the SVD path.
      let inputImage: string | undefined
      let srcW = 0
      let srcH = 0
      if (typeof args.inputImage === 'string' && args.inputImage) {
        let resolved: ResolvedInputImage
        try {
          resolved = await resolveInputImage(args.inputImage)
        } catch (e) {
          if (_lastImageFilename) {
            log.warn('vram_handoff.i2v_input_fallback', { bad: String(args.inputImage), fallback: _lastImageFilename })
            resolved = await resolveInputImage(_lastImageFilename)
          } else {
            throw e
          }
        }
        inputImage = resolved.name
        srcW = resolved.width
        srcH = resolved.height
      }

      const frameRej = videoFrameReject(model, args, caps)
      if (frameRej) return frameRej
      // 24 fps native; up to ~7 s (169 frames). resolveClip honors `seconds`/`frames`.
      const vMax = caps?.frameRange?.max ?? 169
      const { frames, fps } = resolveClip(args, { defFps: d.fps, defFrames: d.frames, maxFrames: vMax })
      const tun = resolveTunables(args, caps, { steps: d.steps, cfg: d.cfg, sampler: d.sampler, scheduler: d.scheduler })
      if (tun.reject) return `Cannot generate: ${tun.reject}`
      // resolveTunables falls back to the generic KSampler caps default (cfg 8 /
      // 20 steps) over our model default. Wan 2.2 5B over-cooks at cfg 8 — its
      // known-good sampling is cfg ~5 / ~30 steps. Honor an explicit user ask,
      // else force the Wan default (David 2026-06-11: "Qualität muss stimmen").
      const avq = args as Record<string, unknown>
      const tunSteps = avq.steps !== undefined ? tun.steps : d.steps
      const tunCfg = (avq.cfg ?? avq.cfg_scale ?? avq.cfgScale) !== undefined ? tun.cfg : d.cfg

      // I2V → resolution from the source aspect (faithful framing); T2V → model default.
      const base = inputImage ? resolveI2VResolution('wan22', srcW, srcH) : { width: d.width, height: d.height }
      const snapped = snapToVideoGrid(clampInt(av.width, base.width, 64, 2048), clampInt(av.height, base.height, 64, 2048))
      const seed = (typeof av.seed === 'number' && Number.isFinite(av.seed)) ? Math.floor(av.seed) : -1

      const workflow = await buildDynamicWorkflow(
        {
          prompt,
          negativePrompt: typeof args.negativePrompt === 'string' ? args.negativePrompt : '',
          model,
          sampler: tun.sampler,
          scheduler: tun.scheduler,
          steps: tunSteps,
          cfgScale: tunCfg,
          width: snapped.width,
          height: snapped.height,
          seed,
          batchSize: 1,
          frames,
          fps,
          ...(inputImage ? { inputImage } : {}),
        },
        type,
      )
      log.info('vram_handoff.video.submit', { model, mode: inputImage ? 'i2v' : 't2v', wan22: true, steps: tunSteps, cfg: tunCfg })
      const promptId = await submitWorkflow(workflow)
      log.info('vram_handoff.video.submitted', { promptId })
      return await pollAndExtract(promptId, prompt, label('video'), getVideoTimeoutMs())
    }

    // ── Image-to-video (SVD / FramePack) ───────────────────────────
    // Resolve the still into ComfyUI's input folder and route through the
    // dynamic builder's I2V strategy. Conservative size + low frame count keep
    // it inside 12 GB; SVD bundles its own CLIP-vision + VAE in the checkpoint.
    if (typeof args.inputImage === 'string' && args.inputImage && isI2VModel(model)) {
      const { buildDynamicWorkflow } = await import('./dynamic-workflow')
      // Resolve the source still; if the model gave a wrong/hallucinated name,
      // fall back to the last image LU actually produced this session.
      let resolved: ResolvedInputImage
      try {
        resolved = await resolveInputImage(args.inputImage)
      } catch (e) {
        if (_lastImageFilename) {
          log.warn('vram_handoff.i2v_input_fallback', { bad: String(args.inputImage), fallback: _lastImageFilename })
          resolved = await resolveInputImage(_lastImageFilename)
        } else {
          throw e
        }
      }
      const inputImage = resolved.name
      // SVD-XT genuinely caps ~25 frames. FramePack PACKS long video, so its real
      // ceiling comes from getModelCapabilities (request-driven — David 2026-06-04:
      // "FramePacks frame cap anheben durch input von uns"). REJECT (not clamp) an
      // explicit over-limit request so the user sees the actual max (decision 2).
      const defFps = type === 'framepack' ? 16 : 8
      const frameRej = videoFrameReject(model, args, caps)
      if (frameRej) return frameRej
      const i2vMax = caps?.frameRange?.max ?? (type === 'framepack' ? FRAMEPACK_MAX_FRAMES : 25)
      const { frames, fps } = resolveClip(args, { defFps, defFrames: type === 'framepack' ? 49 : 25, maxFrames: i2vMax })
      const tun = resolveTunables(args, caps, { steps: type === 'framepack' ? 25 : 20, cfg: 3, sampler: 'euler', scheduler: 'normal' })
      if (tun.reject) return `Cannot generate: ${tun.reject}`
      const av = args as Record<string, unknown>
      // Resolution from the SOURCE aspect ratio (David 2026-06-11: portrait
      // stills came back as squished landscape that no longer matched the
      // input). An explicit user width/height still wins; otherwise we pick the
      // model's native bucket and an ImageScale(crop:center) fills it cleanly.
      const native = resolveI2VResolution(type, resolved.width, resolved.height)
      const snapped = snapToVideoGrid(
        clampInt(av.width, native.width, 64, 2048),
        clampInt(av.height, native.height, 64, 2048),
      )
      const seed = (typeof av.seed === 'number' && Number.isFinite(av.seed)) ? Math.floor(av.seed) : -1
      const motionBucketId = clampInt(av.motionBucketId ?? av.motion_bucket_id, 90, 1, 255)
      const workflow = await buildDynamicWorkflow(
        {
          prompt,
          negativePrompt: typeof args.negativePrompt === 'string' ? args.negativePrompt : '',
          model,
          sampler: tun.sampler,
          scheduler: tun.scheduler,
          steps: tun.steps,
          cfgScale: tun.cfg,
          width: snapped.width,
          height: snapped.height,
          seed,
          batchSize: 1,
          frames,
          fps,
          inputImage,
          motionBucketId,
        },
        type,
      )
      log.info('vram_handoff.video.submit', { model, i2v: true })
      const promptId = await submitWorkflow(workflow)
      log.info('vram_handoff.video.submitted', { promptId })
      return await pollAndExtract(promptId, prompt, label('video'), getVideoTimeoutMs())
    }

    // ── Text-to-video ──────────────────────────────────────────────
    const defaults = MODEL_TYPE_DEFAULTS[type] ?? MODEL_TYPE_DEFAULTS.wan
    // Text-to-video (Wan/Hunyuan/etc.) can run longer than SVD. Real ceiling from
    // getModelCapabilities; REJECT (not clamp) an explicit over-limit request.
    const tFrameRej = videoFrameReject(model, args, caps)
    if (tFrameRej) return tFrameRej
    const t2vMax = caps?.frameRange?.max ?? Math.max(defaults.frames, 161)
    const { frames, fps } = resolveClip(args, { defFps: defaults.fps, defFrames: defaults.frames, maxFrames: t2vMax })
    const tun = resolveTunables(args, caps, { steps: defaults.steps, cfg: defaults.cfg, sampler: defaults.sampler, scheduler: defaults.scheduler })
    if (tun.reject) return `Cannot generate: ${tun.reject}`
    const av = args as Record<string, unknown>
    const snapped = snapToVideoGrid(clampInt(av.width, defaults.width, 64, 2048), clampInt(av.height, defaults.height, 64, 2048))
    const seed = (typeof av.seed === 'number' && Number.isFinite(av.seed)) ? Math.floor(av.seed) : -1

    const workflow = await buildTxt2VidWorkflow(
      {
        prompt,
        negativePrompt: typeof args.negativePrompt === 'string' ? args.negativePrompt : '',
        model,
        sampler: tun.sampler,
        scheduler: tun.scheduler,
        steps: tun.steps,
        cfgScale: tun.cfg,
        width: snapped.width,
        height: snapped.height,
        seed,
        batchSize: 1,
        frames,
        fps,
      },
      backend,
    )
    log.info('vram_handoff.video.submit', { model, i2v: false, backend })
    const promptId = await submitWorkflow(workflow)
    log.info('vram_handoff.video.submitted', { promptId })
    return await pollAndExtract(promptId, prompt, label('video'), getVideoTimeoutMs())
  } catch (err) {
    return `${label('video')} generation failed: ${err instanceof Error ? err.message : String(err)}`
  }
}

/**
 * Poll ComfyUI history until the prompt completes, then build the result string
 * in the exact legacy shape so ToolCallBlock renders it inline and useAgentChat
 * feeds it back to the model unchanged. On a ComfyUI-side error, surface the
 * message VERBATIM (Bug-G / honest-UX: an OOM reads as an OOM).
 */
async function pollAndExtract(promptId: string, prompt: string, kindLabel: string, timeoutMs: number): Promise<string> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    await sleep(1000)
    const history = await getHistory(promptId)
    if (history?.status?.completed) {
      const outputs = history.outputs ?? {}
      for (const nodeId of Object.keys(outputs)) {
        const files = extractComfyOutputFiles(outputs[nodeId])
        if (files.length > 0) {
          const f = files[0]
          const url = getImageUrl(f.filename, f.subfolder ?? '', f.type ?? 'output')
          return `${kindLabel} generated: ${f.filename} (prompt: "${prompt}")\n${url}`
        }
      }
      return `${kindLabel} generation completed but no output produced.`
    }
    if (history?.status?.status_str === 'error') {
      // Pull the richest detail ComfyUI gives us: an execution_error carries
      // node_type + exception_type + exception_message (the plain `message`
      // field is usually empty for node errors — David 2026-06-11, FramePack).
      const errEntry = history.status.messages?.find((m: any) => m?.[0] === 'execution_error')?.[1]
      const rawMsg = errEntry?.exception_message
        || history.status.messages?.map((m: any) => m?.[1]?.message).filter(Boolean).join(' | ')
        || history.status.messages?.[0]?.[1]?.message
        || 'Unknown ComfyUI error'
      const hint = comfyErrorHint(errEntry?.node_type, errEntry?.exception_type, String(rawMsg))
      return `${kindLabel} generation failed: ${rawMsg}${hint ? `\n\n${hint}` : ''}`
    }
  }
  const mins = Math.round(timeoutMs / 60000)
  return `${kindLabel} generation timed out after ${mins} minutes.`
}

// ── Small helpers ─────────────────────────────────────────────────

/**
 * Map a known-cryptic ComfyUI node error to an actionable hint (C-fix pattern).
 * Returns '' when we have nothing better to add than the verbatim error.
 * Exported + pure for the unit tests.
 */
export function comfyErrorHint(nodeType: string | undefined, _excType: string | undefined, message: string): string {
  const m = message.toLowerCase()
  // FramePack wrapper version mismatch (David 2026-06-11, RTX 3060): the
  // installed ComfyUI-FramePackWrapper's LoadFramePackModel produces a
  // HyVideoModel its OWN FramePackSampler can't consume. Upstream custom-node
  // bug — independent of LU's workflow (which now loads without OOM).
  if ((nodeType === 'FramePackSampler' || /framepack/i.test(nodeType ?? '')) &&
      m.includes('hyvideomodel') && m.includes('diffusion_model')) {
    return 'This is a bug in the installed ComfyUI-FramePackWrapper custom node (its model loader and sampler are out of sync), not in Locally Uncensored. Update the node from ComfyUI Manager (search "FramePack"), or pick a different image-to-video model (SVD works on 12 GB; Wan 2.2 5B is the recommended higher-quality option).'
  }
  if (m.includes('out of memory') || m.includes('outofmemory') || _excType === 'torch.OutOfMemoryError') {
    return 'Ran out of GPU memory. Try a shorter clip / lower resolution, set VRAM hand-off to "always" in Settings so the chat model is evicted first, or pick a lighter model.'
  }
  // Windows "paging file is too small" (os error 1455, bear5real0o0 GH #61):
  // ComfyUI couldn't commit enough memory while loading a node (often the text
  // encoder / CLIPLoader) because the OS ran out of RAM + pagefile. This is a
  // Windows virtual-memory setting, not an LU bug — point the user at the fix.
  if (m.includes('paging file') || m.includes('os error 1455')) {
    return 'Windows ran out of virtual memory while loading the model (its paging file is too small). This is a Windows setting, not a Locally Uncensored bug. Let Windows manage the page file, or raise it: Settings → System → About → Advanced system settings → Performance → Settings → Advanced → Virtual memory → Change, set a larger custom size, then reboot. Closing other heavy apps or picking a smaller model also helps.'
  }
  return ''
}

function label(kind: 'image' | 'video'): string {
  return kind === 'video' ? 'Video' : 'Image'
}

function clampInt(v: unknown, fallback: number, min: number, max: number): number {
  const n = typeof v === 'number' ? v : Number(v)
  if (!Number.isFinite(n)) return fallback
  return Math.max(min, Math.min(max, Math.round(n)))
}

function clampFloat(v: unknown, fallback: number, min: number, max: number): number {
  const n = typeof v === 'number' ? v : Number(v)
  if (!Number.isFinite(n)) return fallback
  return Math.max(min, Math.min(max, n))
}

// ── Capability validation helpers (v2.5.0 — reject-and-report, decision 2) ──
//
// REJECT, don't clamp: when the user EXPLICITLY asks for a value beyond the
// installed model's real ComfyUI capability, return a clear message with the
// actual limit so they (or the LLM) can retry lower. Only explicit user values
// are checked — our own defaults are never rejected. Exported for unit tests.

export function clampOrReject(label: string, val: number | undefined, range: { min: number; max: number } | undefined): string | null {
  if (val === undefined || range === undefined) return null
  if (val < range.min) return `${label} ${val} is below this model's minimum ${range.min}. Increase it.`
  if (val > range.max) return `${label} ${val} exceeds this model's maximum ${range.max} (from its ComfyUI capabilities). Lower it to ≤${range.max}, or install a model that supports a higher ${label}.`
  return null
}

export function enumReject(label: string, val: string | undefined, options: string[] | undefined): string | null {
  if (!val || !options || options.length === 0) return null
  return options.includes(val) ? null : `${label} "${val}" is not available on this model. Available: ${options.join(', ')}.`
}

interface Tunables { steps: number; cfg: number; sampler: string; scheduler: string; reject: string | null }

/**
 * Resolve steps/cfg/sampler/scheduler from args (explicit user value → else the
 * model/sane default) and reject explicit out-of-range values. Shared by image +
 * video paths. `reject` is non-null only when the USER asked for something the
 * model can't do.
 */
function resolveTunables(
  args: VramHandoffArgs,
  caps: ModelCapabilities | null,
  defs: { steps: number; cfg: number; sampler: string; scheduler: string },
): Tunables {
  const a = args as Record<string, unknown>
  const steps = clampInt(args.steps, caps?.stepsRange?.default ?? defs.steps, 1, 10000)
  const cfgRaw = a.cfg ?? a.cfg_scale ?? a.cfgScale
  const cfg = clampFloat(cfgRaw, caps?.cfgRange?.default ?? defs.cfg, 0, 100)
  const samplerRaw = typeof a.sampler === 'string' ? a.sampler : (typeof a.sampler_name === 'string' ? a.sampler_name : undefined)
  const sampler = samplerRaw ?? defs.sampler
  const scheduler = typeof a.scheduler === 'string' ? a.scheduler : defs.scheduler
  // Report the user's RAW ask in the reject message, not the internally clamped value.
  const stepsAsk = a.steps !== undefined ? Number(a.steps) : undefined
  const cfgAsk = cfgRaw !== undefined ? Number(cfgRaw) : undefined
  const reject =
    clampOrReject('steps', stepsAsk, caps?.stepsRange)
    || clampOrReject('cfg', cfgAsk, caps?.cfgRange)
    || (caps?.usesKSampler
      ? (enumReject('sampler', samplerRaw, caps?.availableSamplers)
        || enumReject('scheduler', typeof a.scheduler === 'string' ? scheduler : undefined, caps?.availableSchedulers))
      : null)
  return { steps, cfg, sampler, scheduler, reject }
}

// resolveClip honors a `seconds` request by lowering playback fps down to a floor
// of 4, so the longest clip a frame-capped model can actually deliver is
// maxFrames / 4 seconds.
const MIN_PLAYBACK_FPS = 4

/**
 * Reject (decision 2) ONLY when the request genuinely exceeds what the model can
 * deliver — NOT when resolveClip would still satisfy it by capping frames and
 * slowing playback (that path is the intended behavior, e.g. SVD seconds=4 →
 * 25f@6fps≈4.2s). Two cases:
 *   - explicit `frames` (the exact-count advanced path) → reject if > model max.
 *   - `seconds` (the duration control) → resolveClip slows fps to honor it, so only
 *     reject when even the slowest playback (maxFrames / 4 fps) can't reach it.
 * Exported for unit tests.
 */
export function videoFrameReject(model: string, args: VramHandoffArgs, caps: ModelCapabilities | null): string | null {
  if (!caps) return null
  // Duration-driven models (FramePack): the real ceiling is seconds (total_second_length).
  if (typeof caps.maxSeconds === 'number' && typeof args.seconds === 'number' && args.seconds > caps.maxSeconds + 0.5) {
    return `Cannot generate: ${model} can make at most ${caps.maxSeconds}s of video (you asked for ${args.seconds}s). Shorten it, or install a model that makes longer clips.`
  }
  if (!caps.frameRange) return null
  const max = caps.frameRange.max
  if (typeof args.frames === 'number' && args.frames > 0 && Math.round(args.frames) > max) {
    return `Cannot generate: ${model} supports at most ${max} frames (you requested ${Math.round(args.frames)}). Lower the frame count, or install a model that makes longer clips (e.g. FramePack or Wan).`
  }
  if (typeof args.seconds === 'number' && args.seconds > 0) {
    const deliverableMaxSec = max / MIN_PLAYBACK_FPS
    if (args.seconds > deliverableMaxSec + 0.5) {
      return `Cannot generate: ${model} can make at most ~${Math.floor(deliverableMaxSec)}s (${max} frames). You asked for ${args.seconds}s. Shorten it, or install a model that makes longer clips (e.g. FramePack or Wan).`
    }
  }
  return null
}

/** Fetch model capabilities; non-fatal (null → caller proceeds with defaults, no validation). */
async function fetchCaps(model: string, kind: 'image' | 'video'): Promise<ModelCapabilities | null> {
  try {
    const m = await import('./comfyui-nodes')
    return await m.getModelCapabilities(model)
  } catch (e) {
    log.warn(`vram_handoff.${kind}.caps_failed`, { model, err: String(e) })
    return null
  }
}

/**
 * Resolve a clip's (frames, fps) from the agent's optional `seconds` / `frames`
 * / `fps`, capped to a model's frame limit.
 *
 * David 2026-06-03: chat videos came out ~1 s because the I2V default was a
 * stubby 14 frames @ 8 fps. Now:
 *  - `seconds` is the preferred control → frames = round(seconds * fps).
 *  - When the requested duration needs more frames than the model can make
 *    (SVD-XT tops out ~25), we KEEP the max frames and LOWER the playback fps
 *    so the clip still LASTS ~seconds (honoring the user's "4 second video";
 *    motion is just a touch slower since SVD can't synthesize more frames).
 *  - With no `seconds` and no `frames`, default to the model's full frame count
 *    (e.g. 25 for SVD ≈ ~3 s, not 1.75 s).
 */
export function resolveClip(
  args: VramHandoffArgs,
  opts: { defFps: number; defFrames: number; maxFrames: number },
): { frames: number; fps: number } {
  const fpsBase = clampInt(args.fps, opts.defFps, 1, 60)
  const wantSeconds = clampFloat(args.seconds, 0, 0, 60) // 0 = not requested
  let frames: number
  if (wantSeconds > 0) frames = Math.round(wantSeconds * fpsBase)
  else if (typeof args.frames === 'number' && Number.isFinite(args.frames)) frames = Math.round(args.frames)
  else frames = opts.defFrames
  frames = Math.max(1, Math.min(opts.maxFrames, frames))
  let fps = fpsBase
  // Duration won't fit at fpsBase (frame cap hit) → slow playback to honor it.
  if (wantSeconds > 0 && frames / fpsBase < wantSeconds - 0.25) {
    fps = Math.max(4, Math.min(60, Math.round(frames / wantSeconds)))
  }
  return { frames, fps }
}

/**
 * Turn an `inputImage` argument (a prior generate result's filename, or a /view
 * URL) into a filename inside ComfyUI's *input* folder, ready for LoadImage.
 * Generated images live in ComfyUI's *output* folder, but LoadImage reads from
 * *input* — so we fetch the referenced image and re-upload it via /upload/image.
 */
interface ResolvedInputImage {
  /** Filename in ComfyUI's input folder, ready for a LoadImage node. */
  name: string
  /** Source pixel dimensions (0 when they could not be probed). */
  width: number
  height: number
}

async function resolveInputImage(ref: string): Promise<ResolvedInputImage> {
  let url: string
  let name: string
  if (/^https?:\/\//i.test(ref)) {
    url = ref
    const m = ref.match(/[?&]filename=([^&]+)/)
    name = m ? decodeURIComponent(m[1]) : 'lu_input.png'
  } else {
    name = ref.replace(/^.*[\\/]/, '')
    url = getImageUrl(name, '', 'output')
  }
  const resp = await fetch(url)
  if (!resp.ok) throw new Error(`could not read input image "${ref}" (HTTP ${resp.status})`)
  const blob = await resp.blob()
  if (!blob || blob.size === 0) {
    throw new Error(`could not read input image "${ref}" — ComfyUI returned an empty file`)
  }
  // Probe the source dimensions so the I2V path can pick the model's native
  // aspect ratio (David 2026-06-11: a portrait still forced into 768×448
  // landscape no longer resembled the source). Best-effort — a probe failure
  // just yields 0×0 and the caller falls back to a sane default.
  let width = 0
  let height = 0
  try {
    const bmp = await createImageBitmap(blob)
    width = bmp.width
    height = bmp.height
    bmp.close()
  } catch { /* dimensions unknown → caller uses defaults */ }
  const file = new File([blob], name, { type: blob.type || 'image/png' })
  const uploaded = await uploadImage(file)
  return { name: uploaded, width, height }
}

/**
 * Pick the generation resolution for an image-to-video model from the SOURCE
 * still's aspect ratio. SVD-XT was trained ONLY at 1024×576 (landscape) and
 * 576×1024 (portrait); feeding it the old fixed 768×448 squished every source
 * and the clip stopped resembling the input. We match the source ORIENTATION
 * to the nearest native bucket; an ImageScale(crop:center) in the workflow
 * then fills it exactly (aspect-fill, no squish). FramePack is far more
 * resolution-flexible, so it just gets a tidy 16-multiple of the source.
 *
 * Exported + pure for the unit tests.
 */
export function resolveI2VResolution(
  type: string,
  srcW: number,
  srcH: number,
): { width: number; height: number } {
  const landscapeDefault = { width: 1024, height: 576 }
  if (!srcW || !srcH || srcW <= 0 || srcH <= 0) {
    return (type === 'svd' || type === 'wan22') ? landscapeDefault : { width: 768, height: 768 }
  }
  const aspect = srcW / srcH
  if (type === 'svd') {
    // Square is closer to landscape than portrait; center-crop handles the rest.
    return aspect >= 0.95 ? { width: 1024, height: 576 } : { width: 576, height: 1024 }
  }
  if (type === 'wan22') {
    // Wan 2.2 5B trains at 1280×704 / 704×1280. Keep the SOURCE aspect (faithful
    // framing) and snap to 32 (the latent grid); an ImageScale(crop:center) in
    // the builder fills it. Budget by TOTAL PIXELS, not the long edge: a square
    // 1024² still (1.05 M px) sits at the VRAM ceiling on a 12 GB 3060 and can't
    // do 5-7 s, while a 16:9 1024×576 (0.59 M px) runs the whole matrix. ~0.6 M
    // px keeps every aspect tractable on 12 GB (David 2026-06-11: 5B I2V must be
    // PRACTICAL + good, not just native-res-but-OOM).
    const BUDGET_PX = 600_000
    let w = srcW
    let h = srcH
    const px = w * h
    if (px > BUDGET_PX) {
      const s = Math.sqrt(BUDGET_PX / px)
      w = Math.round(w * s)
      h = Math.round(h * s)
    }
    const snap = (v: number) => Math.max(64, Math.round(v / 32) * 32)
    return { width: snap(w), height: snap(h) }
  }
  // FramePack / others: keep the real aspect, snap to a 16-multiple, cap the
  // long edge so a 12 GB card stays safe.
  const cap = 768
  let w = srcW
  let h = srcH
  if (Math.max(w, h) > cap) {
    const s = cap / Math.max(w, h)
    w = Math.round(w * s)
    h = Math.round(h * s)
  }
  const snap = (v: number) => Math.max(64, Math.round(v / 16) * 16)
  return { width: snap(w), height: snap(h) }
}

function getImageTimeoutMs(): number {
  // ~5 min default per spec; respect the user's imageGenTimeoutMinutes if set.
  try {
    const mins = readSettingNumber('imageGenTimeoutMinutes')
    if (mins && mins > 0) return mins * 60_000
  } catch { /* ignore */ }
  return 5 * 60_000
}

function getVideoTimeoutMs(): number {
  // ~10 min default per spec; respect videoGenTimeoutMinutes if set.
  try {
    const mins = readSettingNumber('videoGenTimeoutMinutes')
    if (mins && mins > 0) return mins * 60_000
  } catch { /* ignore */ }
  return 10 * 60_000
}

function getExclusiveVramMode(): ExclusiveVramMode {
  try {
    const m = useSettingsStore.getState().settings.exclusiveVramMode
    if (m === 'auto' || m === 'always' || m === 'never') return m
  } catch { /* store not available */ }
  return 'auto'
}

function readSettingNumber(key: 'imageGenTimeoutMinutes' | 'videoGenTimeoutMinutes'): number | null {
  try {
    const v = useSettingsStore.getState().settings[key]
    return typeof v === 'number' ? v : null
  } catch {
    return null
  }
}
