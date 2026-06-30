import { comfyuiUrl, localFetch, fetchLocalhostBytes, isTauri, backendCall } from "./backend"
import { log } from "../lib/logger"

// ─── Control-plane fetch timeouts ───
//
// These ComfyUI endpoints enqueue / list / poll / free and MUST answer in well
// under a few seconds on localhost: ComfyUI serves them on its asyncio event
// loop while the actual generation runs on a SEPARATE worker thread, so HTTP
// stays responsive even mid-render. A generation's real compute time is observed
// by repeatedly polling /history (each poll quick), NOT by any single long-lived
// fetch. Without an explicit cap every call below inherits the Rust proxy's
// 300 s default — and ONE wedged control call (e.g. /object_info right after a
// ComfyUI restart, or a /prompt POST that never returns) froze the whole image-
// MCP VRAM hand-off for minutes with the text model left unloaded (chat-agent
// hang, 2026-06-03). Bounding each call converts that infinite stall into a fast,
// clean error so the hand-off's `finally` can always free VRAM + reload the model.
const COMFY_LIST_TIMEOUT_MS = 15_000    // /object_info/<Node> single-node listings
const COMFY_SUBMIT_TIMEOUT_MS = 30_000  // POST /prompt — validates + enqueues, returns prompt_id only
const COMFY_POLL_TIMEOUT_MS = 15_000    // GET /history/<id> per status poll
const COMFY_STATS_TIMEOUT_MS = 10_000   // /system_stats, /api/refresh, /interrupt
const COMFY_FREE_TIMEOUT_MS = 20_000    // POST /free — VRAM release

// ─── Types ───

export interface GenerateParams {
  prompt: string
  negativePrompt: string
  model: string
  sampler: string
  scheduler: string
  steps: number
  cfgScale: number
  width: number
  height: number
  seed: number
  batchSize: number
  inputImage?: string   // I2I source image filename (uploaded to ComfyUI)
  denoise?: number      // I2I denoise strength (0.0–1.0, default 1.0 = full txt2img)
  // F2 (cinemazverev GH#4), extended for multi-LoRA (konata 2026-06-09:
  // "agent cannot load multiple loras"): one filename or an ordered list.
  // Multiple LoRAs are CHAINED — LoraLoader N feeds (model, clip) into
  // LoraLoader N+1, exactly like stacking them in the ComfyUI graph editor.
  // `loraStrength` mirrors LoraLoader's `strength_model` (0..2 typical):
  // a single number applies to every LoRA, an array maps per-LoRA by index.
  lora?: string | string[]
  loraStrength?: number | number[]
  // F3 (vanja-san GH#4): override the checkpoint's bundled VAE with an
  // explicit VAELoader. 'auto' / undefined / empty = keep the
  // checkpoint VAE.
  vae?: string
  // F3: optional CLIPSetLastLayer injection. 0 = no skip (the
  // checkpoint default). Common values: 1 for SD1.5/SDXL,
  // 2 for some abliterated finetunes.
  clipSkip?: number
}

export interface VideoParams extends GenerateParams {
  frames: number
  fps: number
  inputImage?: string  // Uploaded image filename for I2V models (SVD, FramePack)
  // SVD motion strength (motion_bucket_id, 1–255). Lower = more faithful to the
  // source still / calmer motion; 127 (SVD default) drifts hard. We default ~90
  // for I2V fidelity (David 2026-06-11). Honoured only by the SVD path.
  motionBucketId?: number
}

export interface ComfyUIOutput {
  filename: string
  subfolder: string
  type: string
}

/**
 * Bug R (v2.4.7 — silentrunningcaUSA GH Discussion #6, 2026-05-20).
 *
 * Pre-v2.4.7 LU only scraped `images` / `gifs` / `videos` from a ComfyUI
 * history `outputs[nodeId]` payload. That worked for the canonical SaveImage
 * / SaveAnimatedWEBP / VHS_VideoCombine nodes, but plenty of custom save
 * nodes (community workflows from CivitAI, SaveImageWithMetadata,
 * SaveImageHTML, audio save nodes, etc.) post under different keys —
 * `audio`, `result`, `files`, `latents`, `meshes`, model-specific keys.
 * The file lands in ComfyUI's `output/` folder but never makes it into LU's
 * gallery, exactly the symptom silentrunningcaUSA reported.
 *
 * Generic extractor: scan every key on the node output, collect any array
 * whose entries look like `{ filename, subfolder?, type? }`. Defaults fill
 * in subfolder='' and type='output' so the gallery + comfyImageUrl can build
 * a working URL even when a custom save node omits them.
 */
export function extractComfyOutputFiles(nodeOutput: unknown): ComfyUIOutput[] {
  if (!nodeOutput || typeof nodeOutput !== 'object') return []
  const found: ComfyUIOutput[] = []
  for (const value of Object.values(nodeOutput as Record<string, unknown>)) {
    if (!Array.isArray(value)) continue
    for (const item of value) {
      if (
        item &&
        typeof item === 'object' &&
        'filename' in item &&
        typeof (item as { filename: unknown }).filename === 'string'
      ) {
        const it = item as { filename: string; subfolder?: unknown; type?: unknown }
        found.push({
          filename: it.filename,
          subfolder: typeof it.subfolder === 'string' ? it.subfolder : '',
          type: typeof it.type === 'string' ? it.type : 'output',
        })
      }
    }
  }
  return found
}

export type ModelType = 'flux' | 'flux2' | 'zimage' | 'ernie_image' | 'sdxl' | 'sd15' | 'wan' | 'wan22' | 'hunyuan' | 'ltx' | 'mochi' | 'cosmos' | 'cogvideo' | 'svd' | 'framepack' | 'pyramidflow' | 'allegro' | 'unknown'
export type VideoBackend = 'wan' | 'animatediff' | 'none'

export interface ClassifiedModel {
  name: string
  type: ModelType
  source: 'checkpoint' | 'diffusion_model'
}

// ─── Model Classification ───

// Known community models → pre-classified for reliability
const KNOWN_MODELS: Record<string, ModelType> = {
  juggernaut: 'sdxl',
  realvis: 'sdxl',
  animagine: 'sdxl',
  pony: 'sdxl',
  illustrious: 'sdxl',
  noobai: 'sdxl',
  proteus: 'sdxl',
  copax: 'sdxl',
  zavychroma: 'sdxl',
  epicrealism: 'sdxl',
  realisticvision: 'sd15',
  deliberate: 'sd15',
  revanimated: 'sd15',
  dreamshaper: 'sd15', // dreamshaper XL handled by 'xl' check first
  absolutereality: 'sd15',
}

export function classifyModel(name: string | null | undefined): ModelType {
  // Defensive: treat empty/missing names as unknown. Older installs can persist
  // stale model strings that no longer exist; callers should not crash on those.
  if (!name || typeof name !== 'string') return 'unknown'
  const lower = name.toLowerCase()

  // Video models — most specific first (order matters: specific before generic)
  if (lower.includes('cogvideo')) return 'cogvideo'
  if (lower.includes('framepack')) return 'framepack'
  if (lower.includes('mochi')) return 'mochi'
  if (lower.includes('cosmos')) return 'cosmos'
  if (lower.includes('allegro')) return 'allegro'
  if (lower.includes('svd') || lower.includes('stable-video-diffusion')) return 'svd'
  if (lower.includes('pyramid') && (lower.includes('flow') || lower.includes('dit'))) return 'pyramidflow'
  // Wan 2.2 TI2V-5B — unified text+image-to-video. Detect BEFORE the generic Wan
  // match: it needs its own latent node (Wan22ImageToVideoLatent), the Wan 2.2 VAE
  // and the dual T2V/I2V path, none of which the Wan 2.1 'unet_video' strategy has.
  if (lower.includes('ti2v') || lower.includes('wan2.2') || lower.includes('wan2_2') || lower.includes('wan22')) return 'wan22'
  if (lower.includes('wan')) return 'wan'
  if (lower.includes('hunyuan')) return 'hunyuan'
  if (lower.includes('ltx')) return 'ltx'

  // ERNIE-Image (Baidu, uses flux2 CLIP type + ConditioningZeroOut for negative)
  if (lower.includes('ernie-image') || lower.includes('ernie_image')) return 'ernie_image'

  // Z-Image (uses qwen_image CLIP type, NOT flux2 — different embedding dimensions)
  if (lower.includes('z_image') || lower.includes('z-image') || lower.includes('zimage')) return 'zimage'
  if (lower.includes('flux-2') || lower.includes('flux2')) return 'flux2'
  if (lower.includes('flux')) return 'flux'

  // Explicit architecture tags
  if (lower.includes('sdxl') || lower.includes('sd_xl')) return 'sdxl'
  if (lower.includes('sd15') || lower.includes('sd_1') || lower.includes('v1-5') || lower.includes('sd1.5')) return 'sd15'

  // "xl" suffix/tag (but not "xxl" which is a text encoder)
  if (/[_\-.]xl[_\-.]|[_\-.]xl$|_xl_/i.test(name)) return 'sdxl'

  // Known community model names
  for (const [keyword, type] of Object.entries(KNOWN_MODELS)) {
    if (lower.includes(keyword)) return type
  }

  // SD 1.5 patterns
  if (lower.includes('1.5') || lower.includes('v1_5')) return 'sd15'

  return 'unknown'
}

export function isImageModelType(type: ModelType): boolean {
  return type === 'flux' || type === 'flux2' || type === 'zimage' || type === 'ernie_image' || type === 'sdxl' || type === 'sd15' || type === 'unknown'
}

export function isVideoModelType(type: ModelType): boolean {
  return type === 'wan' || type === 'wan22' || type === 'hunyuan' || type === 'ltx' || type === 'mochi' || type === 'cosmos'
    || type === 'cogvideo' || type === 'svd' || type === 'framepack' || type === 'pyramidflow' || type === 'allegro'
}

/**
 * Can this model accept a source still (image-to-video)? True for explicit i2v
 * tags, SVD, FramePack, and Wan 2.2 TI2V (which is dual T2V/I2V). Used to build
 * the I2V picker list and to route an inputImage to the I2V branch.
 */
export function isI2VModel(name: string): boolean {
  const lower = name.toLowerCase()
  return lower.includes('i2v') || lower.includes('svd') || lower.includes('framepack')
    || lower.includes('ti2v') || lower.includes('wan2.2') || lower.includes('wan2_2') || lower.includes('wan22')
}

/**
 * Can this model do TEXT-to-video (no source image required)? Everything EXCEPT
 * the I2V-ONLY checkpoints: SVD and FramePack load via image-only/wrapper loaders,
 * and a CogVideoX *I2V* checkpoint needs a still — none can run a T2V graph. Wan 2.2
 * TI2V is dual-capable, so it stays in the T2V list too (the `ti2v`/`wan2.2` guard
 * wins over the generic `i2v` substring). Keeps wan22 selectable for both modes.
 */
export function isT2VCapable(name: string): boolean {
  const lower = name.toLowerCase()
  if (lower.includes('ti2v') || lower.includes('wan2.2') || lower.includes('wan2_2') || lower.includes('wan22')) return true
  if (lower.includes('svd') || lower.includes('framepack')) return false
  if (lower.includes('i2v')) return false
  return true
}

// ─── Default generation parameters per model type ───

export interface ModelTypeDefaults {
  steps: number
  cfg: number
  sampler: string
  scheduler: string
  width: number
  height: number
  frames: number
  fps: number
}

export const MODEL_TYPE_DEFAULTS: Record<string, ModelTypeDefaults> = {
  wan: { steps: 30, cfg: 6.0, sampler: 'euler', scheduler: 'normal', width: 832, height: 480, frames: 81, fps: 16 },
  // Wan 2.2 TI2V-5B — native 1280×704 @ 24 fps, unified T2V/I2V. Default to a
  // VRAM-/speed-friendly 1024×576 16:9 on 12 GB cards (native res is still available
  // by setting width/height); 49 frames ≈ 2 s, the duration matrix runs up to ~7 s.
  wan22: { steps: 30, cfg: 5.0, sampler: 'euler', scheduler: 'simple', width: 1024, height: 576, frames: 49, fps: 24 },
  hunyuan: { steps: 30, cfg: 6.0, sampler: 'euler', scheduler: 'normal', width: 848, height: 480, frames: 45, fps: 24 },
  ltx: { steps: 20, cfg: 3.0, sampler: 'euler', scheduler: 'normal', width: 768, height: 512, frames: 97, fps: 24 },
  mochi: { steps: 30, cfg: 4.5, sampler: 'euler', scheduler: 'normal', width: 848, height: 480, frames: 84, fps: 24 },
  cosmos: { steps: 35, cfg: 7.0, sampler: 'euler', scheduler: 'normal', width: 1024, height: 1024, frames: 121, fps: 24 },
  cogvideo: { steps: 50, cfg: 6.0, sampler: 'euler_ancestral', scheduler: 'normal', width: 480, height: 480, frames: 49, fps: 8 },
  svd: { steps: 20, cfg: 2.5, sampler: 'euler', scheduler: 'karras', width: 576, height: 1024, frames: 25, fps: 6 },
  framepack: { steps: 25, cfg: 7.0, sampler: 'euler', scheduler: 'normal', width: 640, height: 480, frames: 49, fps: 24 },
  pyramidflow: { steps: 20, cfg: 7.0, sampler: 'euler', scheduler: 'normal', width: 768, height: 1280, frames: 16, fps: 8 },
  allegro: { steps: 100, cfg: 7.5, sampler: 'euler', scheduler: 'normal', width: 720, height: 1280, frames: 88, fps: 15 },
  animatediff: { steps: 20, cfg: 7.5, sampler: 'euler_ancestral', scheduler: 'normal', width: 512, height: 512, frames: 16, fps: 8 },
  // AnimateDiff Lightning override (4 steps only)
  animatediff_lightning: { steps: 4, cfg: 1.0, sampler: 'euler', scheduler: 'sgm_uniform', width: 512, height: 512, frames: 16, fps: 8 },
  // ERNIE-Image Turbo (Baidu 8B DiT)
  ernie_image: { steps: 8, cfg: 1, sampler: 'euler', scheduler: 'simple', width: 1024, height: 1024, frames: 1, fps: 1 },
}

// ─── Component Requirements per model type ───

export interface ComponentSpec {
  matchPatterns: string[]
  downloadFilename: string
  downloadUrl?: string
}

export interface ComponentRequirements {
  loader: 'UNETLoader' | 'CheckpointLoaderSimple' | 'ImageOnlyCheckpointLoader'
  needsSeparateVAE: boolean
  needsSeparateCLIP: boolean
  vae?: ComponentSpec
  clip?: ComponentSpec
  clipType?: string
}

export const COMPONENT_REGISTRY: Record<string, ComponentRequirements> = {
  sd15: { loader: 'CheckpointLoaderSimple', needsSeparateVAE: false, needsSeparateCLIP: false },
  sdxl: { loader: 'CheckpointLoaderSimple', needsSeparateVAE: false, needsSeparateCLIP: false },
  flux: {
    loader: 'UNETLoader', needsSeparateVAE: true, needsSeparateCLIP: true, clipType: 'flux',
    vae: { matchPatterns: ['ae', 'flux'], downloadFilename: 'ae.safetensors' },
    clip: { matchPatterns: ['t5'], downloadFilename: 't5xxl_fp8_e4m3fn.safetensors' },
  },
  flux2: {
    loader: 'UNETLoader', needsSeparateVAE: true, needsSeparateCLIP: true, clipType: 'flux2',
    vae: { matchPatterns: ['flux2', 'flux'], downloadFilename: 'flux2-vae.safetensors' },
    clip: { matchPatterns: ['qwen', 'mistral'], downloadFilename: 'qwen_3_4b_fp4_flux2.safetensors' },
  },
  zimage: {
    loader: 'UNETLoader', needsSeparateVAE: true, needsSeparateCLIP: true, clipType: 'qwen_image',
    vae: { matchPatterns: ['ae', 'flux'], downloadFilename: 'ae.safetensors' },
    clip: { matchPatterns: ['qwen_3_4b', 'qwen3'], downloadFilename: 'qwen_3_4b.safetensors' },
  },
  ernie_image: {
    loader: 'UNETLoader', needsSeparateVAE: true, needsSeparateCLIP: true, clipType: 'flux2',
    vae: { matchPatterns: ['flux2-vae', 'flux2', 'flux'], downloadFilename: 'flux2-vae.safetensors' },
    clip: { matchPatterns: ['ministral-3-3b', 'ministral', 'ernie-image-prompt-enhancer'], downloadFilename: 'ministral-3-3b.safetensors' },
  },
  wan: {
    loader: 'UNETLoader', needsSeparateVAE: true, needsSeparateCLIP: true, clipType: 'wan',
    vae: { matchPatterns: ['wan', 'hunyuan'], downloadFilename: 'wan_2.1_vae.safetensors' },
    clip: { matchPatterns: ['umt5', 'wan'], downloadFilename: 'umt5_xxl_fp8_e4m3fn_scaled.safetensors' },
  },
  hunyuan: {
    loader: 'UNETLoader', needsSeparateVAE: true, needsSeparateCLIP: true, clipType: 'wan',
    vae: { matchPatterns: ['hunyuanvideo', 'hunyuan', 'wan'], downloadFilename: 'hunyuanvideo15_vae_fp16.safetensors' },
    clip: { matchPatterns: ['qwen', 'llava', 'umt5'], downloadFilename: 'qwen_2.5_vl_7b_fp8_scaled.safetensors' },
  },
  ltx: {
    loader: 'UNETLoader', needsSeparateVAE: false, needsSeparateCLIP: true, clipType: 'ltxv',
    clip: { matchPatterns: ['gemma'], downloadFilename: 'gemma_3_12B_it_fp8_scaled.safetensors' },
  },
  mochi: {
    loader: 'UNETLoader', needsSeparateVAE: true, needsSeparateCLIP: true, clipType: 'mochi',
    vae: { matchPatterns: ['mochi'], downloadFilename: 'mochi_vae.safetensors' },
    clip: { matchPatterns: ['t5'], downloadFilename: 't5xxl_fp16.safetensors' },
  },
  cosmos: {
    loader: 'UNETLoader', needsSeparateVAE: true, needsSeparateCLIP: true, clipType: 'cosmos',
    vae: { matchPatterns: ['cosmos'], downloadFilename: 'cosmos_cv8x8x8_1.0.safetensors' },
    clip: { matchPatterns: ['oldt5'], downloadFilename: 'oldt5_xxl_fp8_e4m3fn_scaled.safetensors' },
  },
  cogvideo: {
    loader: 'UNETLoader', needsSeparateVAE: true, needsSeparateCLIP: true, clipType: 'cogvideo',
    vae: { matchPatterns: ['cogvideox', 'cogvideo'], downloadFilename: 'cogvideox_vae_bf16.safetensors' },
    clip: { matchPatterns: ['t5'], downloadFilename: 't5xxl_fp16.safetensors' },
  },
  svd: {
    loader: 'ImageOnlyCheckpointLoader', needsSeparateVAE: false, needsSeparateCLIP: false,
  },
  framepack: {
    loader: 'UNETLoader', needsSeparateVAE: true, needsSeparateCLIP: true, clipType: 'wan',
    vae: { matchPatterns: ['hunyuan', 'wan'], downloadFilename: 'hunyuanvideo15_vae_fp16.safetensors' },
    clip: { matchPatterns: ['llava', 'qwen', 'umt5'], downloadFilename: 'llava_llama3_fp8_scaled.safetensors' },
  },
  pyramidflow: {
    loader: 'UNETLoader', needsSeparateVAE: true, needsSeparateCLIP: false, clipType: 'pyramidflow',
    vae: { matchPatterns: ['pyramid'], downloadFilename: 'pyramid_flow_vae_bf16.safetensors' },
  },
  allegro: {
    loader: 'UNETLoader', needsSeparateVAE: false, needsSeparateCLIP: false, clipType: 'allegro',
  },
  unknown: { loader: 'CheckpointLoaderSimple', needsSeparateVAE: false, needsSeparateCLIP: false },
}

// ─── Connection & Info ───

export async function checkComfyConnection(): Promise<boolean> {
  try {
    const res = await localFetch(comfyuiUrl('/system_stats'))
    return res.ok
  } catch {
    return false
  }
}

/**
 * Force ComfyUI to re-scan model directories. Works on ComfyUI 2024+ with
 * /api/refresh.
 *
 * Retries on transient failures because in production we hit two real-world
 * race conditions:
 *  1. ComfyUI is mid-startup and `/api/refresh` 404s briefly (Discord report
 *     from Draekzy: logs show repeated localhost:8188 connect errors after a
 *     fresh download lands).
 *  2. ComfyUI is busy executing a workflow and accepts the refresh but doesn't
 *     finish the directory scan before we query `/object_info`.
 *
 * For both cases a single attempt silently returned `false` and the caller
 * never knew the cache stayed stale.
 */
export async function refreshComfyModels(maxAttempts = 3): Promise<boolean> {
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      const res = await localFetch(comfyuiUrl('/api/refresh'), { method: 'POST', timeoutMs: COMFY_STATS_TIMEOUT_MS })
      if (res.ok) return true
    } catch { /* network blip — retry */ }
    if (attempt < maxAttempts - 1) {
      await new Promise(r => setTimeout(r, 1000 * (attempt + 1)))
    }
  }
  return false // Older ComfyUI versions without /api/refresh — non-fatal
}

// ─── System VRAM Detection ───

let cachedVRAM: number | null = null

export async function getSystemVRAM(): Promise<number | null> {
  if (cachedVRAM !== null) return cachedVRAM
  try {
    const res = await localFetch(comfyuiUrl('/system_stats'), { timeoutMs: COMFY_STATS_TIMEOUT_MS })
    if (!res.ok) return null
    const data = await res.json()
    // ComfyUI returns top-level devices[].vram_total in bytes
    const devices = data?.devices ?? []
    if (devices.length > 0) {
      const vramBytes = devices[0]?.vram_total ?? 0
      cachedVRAM = Math.round(vramBytes / (1024 * 1024 * 1024)) // bytes → GB
      return cachedVRAM
    }
  } catch { /* ComfyUI not running */ }
  return null
}

// Check if a specific node exists in ComfyUI (lightweight, single node check)
async function nodeExists(nodeName: string): Promise<boolean> {
  try {
    const res = await localFetch(comfyuiUrl(`/object_info/${nodeName}`), { timeoutMs: COMFY_LIST_TIMEOUT_MS })
    if (!res.ok) return false
    const data = await res.json()
    return !!(data && data[nodeName])
  } catch {
    return false
  }
}

export async function getCheckpoints(): Promise<string[]> {
  const res = await localFetch(comfyuiUrl('/object_info/CheckpointLoaderSimple'), { timeoutMs: COMFY_LIST_TIMEOUT_MS })
  if (!res.ok) throw new Error(`ComfyUI /object_info/CheckpointLoaderSimple failed (HTTP ${res.status})`)
  const data = await res.json()
  return data?.CheckpointLoaderSimple?.input?.required?.ckpt_name?.[0] ?? []
}

export async function getDiffusionModels(): Promise<string[]> {
  const res = await localFetch(comfyuiUrl('/object_info/UNETLoader'), { timeoutMs: COMFY_LIST_TIMEOUT_MS })
  if (!res.ok) throw new Error(`ComfyUI /object_info/UNETLoader failed (HTTP ${res.status})`)
  const data = await res.json()
  return data?.UNETLoader?.input?.required?.unet_name?.[0] ?? []
}

export async function getVAEModels(): Promise<string[]> {
  try {
    const res = await localFetch(comfyuiUrl('/object_info/VAELoader'), { timeoutMs: COMFY_LIST_TIMEOUT_MS })
    if (!res.ok) return []
    const data = await res.json()
    return data?.VAELoader?.input?.required?.vae_name?.[0] ?? []
  } catch (err) {
    log.warn('comfyui.fetch_vae_failed', { err })
    return []
  }
}

export async function getCLIPModels(): Promise<string[]> {
  try {
    const res = await localFetch(comfyuiUrl('/object_info/CLIPLoader'), { timeoutMs: COMFY_LIST_TIMEOUT_MS })
    if (!res.ok) return []
    const data = await res.json()
    return data?.CLIPLoader?.input?.required?.clip_name?.[0] ?? []
  } catch (err) {
    log.warn('comfyui.fetch_clip_failed', { err })
    return []
  }
}

/**
 * F2 (cinemazverev GH#4): list LoRA files ComfyUI knows about. Pulls
 * the same enum LoraLoader's `lora_name` dropdown shows — anything the
 * user dropped into `<comfyui>/models/loras/`. Soft-fails to `[]` when
 * the LoraLoader node isn't registered (custom-node ComfyUI distros).
 */
export async function getLoraModels(): Promise<string[]> {
  try {
    const res = await localFetch(comfyuiUrl('/object_info/LoraLoader'), { timeoutMs: COMFY_LIST_TIMEOUT_MS })
    if (!res.ok) return []
    const data = await res.json()
    return data?.LoraLoader?.input?.required?.lora_name?.[0] ?? []
  } catch (err) {
    log.warn('comfyui.fetch_lora_failed', { err })
    return []
  }
}

export async function getSamplers(): Promise<string[]> {
  try {
    const res = await localFetch(comfyuiUrl('/object_info/KSampler'), { timeoutMs: COMFY_LIST_TIMEOUT_MS })
    if (!res.ok) throw new Error('Failed')
    const data = await res.json()
    return data?.KSampler?.input?.required?.sampler_name?.[0] ?? []
  } catch {
    return ['euler', 'euler_ancestral', 'dpmpp_2m', 'dpmpp_2m_sde', 'dpmpp_sde', 'uni_pc', 'ddim']
  }
}

export async function getSchedulers(): Promise<string[]> {
  try {
    const res = await localFetch(comfyuiUrl('/object_info/KSampler'), { timeoutMs: COMFY_LIST_TIMEOUT_MS })
    if (!res.ok) throw new Error('Failed')
    const data = await res.json()
    return data?.KSampler?.input?.required?.scheduler?.[0] ?? []
  } catch {
    return ['normal', 'karras', 'simple', 'exponential', 'sgm_uniform']
  }
}

export async function getAnimateDiffModels(): Promise<string[]> {
  try {
    const res = await localFetch(comfyuiUrl('/object_info/ADE_LoadAnimateDiffModel'))
    if (!res.ok) return []
    const data = await res.json()
    return data?.ADE_LoadAnimateDiffModel?.input?.required?.model_name?.[0] ?? []
  } catch {
    return []
  }
}

// ─── Partial Download Filter ───
// Filters out files that exist on disk but are incomplete (< 90% of expected size).
// Uses known bundle file sizes from discover.ts. Unknown files pass through.

let _knownFileSizes: Map<string, { subfolder: string; expectedBytes: number }> | null = null

async function getKnownFileSizes(): Promise<Map<string, { subfolder: string; expectedBytes: number }>> {
  if (_knownFileSizes) return _knownFileSizes
  // Dynamic import (not CommonJS require) — discover.ts imports back into
  // comfyui.ts for classification helpers, so we defer the import to break
  // the cycle at runtime instead of at module init.
  const { getImageBundles, getVideoBundles } = await import('./discover')
  _knownFileSizes = new Map()
  for (const bundle of [...getImageBundles(), ...getVideoBundles()]) {
    for (const f of (bundle as any).files) {
      if (f.filename && f.sizeGB && f.subfolder) {
        _knownFileSizes.set(f.filename, {
          subfolder: f.subfolder,
          expectedBytes: Math.round(f.sizeGB * 1_073_741_824),
        })
      }
    }
  }
  return _knownFileSizes
}

/** Filter out partially downloaded files. Returns only filenames that are complete. */
export async function filterPartialFiles(filenames: string[]): Promise<Set<string>> {
  const known = await getKnownFileSizes()
  const filesToCheck = filenames
    .filter(name => known.has(name))
    .map(name => {
      const info = known.get(name)!
      return { subfolder: info.subfolder, filename: name, expectedBytes: info.expectedBytes }
    })

  if (filesToCheck.length === 0) return new Set(filenames) // nothing to check → all pass

  try {
    const { backendCall } = await import('./backend')
    const results: Array<{ filename: string; exists?: boolean; complete: boolean }> =
      await backendCall('check_model_sizes', { files: filesToCheck })
    // Only hide a model when it is CONFIRMED partial: present on disk but too
    // small (exists === true && !complete). A bare `!complete` also dropped
    // files the size-checker simply couldn't locate (exists === false) — which
    // happens whenever the checker looks at the wrong ComfyUI path (the dev
    // server's hardcoded path guesses, a custom/remote comfy host, etc.). But
    // these filenames came FROM ComfyUI's own /object_info enums, so ComfyUI
    // can load them — never hide a model ComfyUI vouches for just because a
    // secondary size probe missed it (konata 2026-06-07: "no image model"
    // even though ComfyUI had Juggernaut/RealVis installed).
    const incomplete = new Set(results.filter(r => r.exists === true && !r.complete).map(r => r.filename))
    if (incomplete.size > 0) {
      log.info('comfyui.filtered_partial_downloads', { count: incomplete.size, files: [...incomplete] })
    }
    return new Set(filenames.filter(name => !incomplete.has(name)))
  } catch {
    return new Set(filenames) // if check fails, show all (backward compat)
  }
}

// ─── Classified Model Lists ───

export async function getImageModels(): Promise<ClassifiedModel[]> {
  const [checkpoints, diffModels] = await Promise.all([getCheckpoints(), getDiffusionModels()])
  const complete = await filterPartialFiles([...checkpoints, ...diffModels])
  const result: ClassifiedModel[] = []

  for (const name of checkpoints) {
    if (!complete.has(name)) continue
    const type = classifyModel(name)
    // Skip video-type checkpoints (e.g. SVD) — they belong in getVideoModels()
    if (isVideoModelType(type)) continue
    result.push({ name, type: isImageModelType(type) ? type : 'sdxl', source: 'checkpoint' })
  }

  for (const name of diffModels) {
    if (!complete.has(name)) continue
    const type = classifyModel(name)
    if (isImageModelType(type)) {
      result.push({ name, type, source: 'diffusion_model' })
    }
  }

  return result
}

export async function getVideoModels(): Promise<ClassifiedModel[]> {
  const [checkpoints, diffModels] = await Promise.all([getCheckpoints(), getDiffusionModels()])
  const complete = await filterPartialFiles([...checkpoints, ...diffModels])
  const result: ClassifiedModel[] = []

  // Video checkpoints (e.g. SVD)
  for (const name of checkpoints) {
    if (!complete.has(name)) continue
    const type = classifyModel(name)
    if (isVideoModelType(type)) {
      result.push({ name, type, source: 'checkpoint' })
    }
  }

  for (const name of diffModels) {
    if (!complete.has(name)) continue
    const type = classifyModel(name)
    if (isVideoModelType(type)) {
      result.push({ name, type, source: 'diffusion_model' })
    }
  }

  return result
}

// ─── Detect Video Backend (checks individual nodes + models — no full object_info fetch) ───

export async function detectVideoBackend(): Promise<VideoBackend> {
  try {
    // Check Wan/Hunyuan: need specific nodes AND actual video models
    const [hasWanLatent, hasUNET, hasCLIP, hasVAE, videoModels] = await Promise.all([
      nodeExists('EmptyHunyuanLatentVideo'),
      nodeExists('UNETLoader'),
      nodeExists('CLIPLoader'),
      nodeExists('VAELoader'),
      getVideoModels(),
    ])

    if (hasWanLatent && hasUNET && hasCLIP && hasVAE && videoModels.length > 0) {
      return 'wan'
    }

    // Check AnimateDiff: need custom extension nodes
    const [hasADELoad, hasADESampling] = await Promise.all([
      nodeExists('ADE_LoadAnimateDiffModel'),
      nodeExists('ADE_UseEvolvedSampling'),
    ])
    if (hasADELoad && hasADESampling) return 'animatediff'
  } catch (err) {
    log.warn('comfyui.detect_video_backend_failed', { err })
  }
  return 'none'
}

// ─── Auto-find matching VAE/CLIP for a model ───

export async function findMatchingVAE(modelType: ModelType): Promise<string> {
  const vaes = await getVAEModels()
  if (vaes.length === 0) throw new Error('No VAE models found. Download a VAE for your model type from the Model Manager.')
  const lower = (s: string) => s.toLowerCase()

  if (modelType === 'zimage') {
    // Z-Image uses ae.safetensors (same as FLUX but prefer exact match)
    const match = vaes.find(v => lower(v) === 'ae.safetensors')
      || vaes.find(v => lower(v).includes('ae'))
      || vaes.find(v => lower(v).includes('flux'))
    if (match) return match
    throw new Error(`No Z-Image VAE found. Download "ae.safetensors" from the Model Manager.`)
  }
  if (modelType === 'flux') {
    // FLUX.1 uses the 16-channel ae.safetensors autoencoder, NOT the FLUX 2 VAE.
    const match = vaes.find(v => lower(v) === 'ae.safetensors')
      || vaes.find(v => lower(v).includes('ae') && !lower(v).includes('flux2'))
      || vaes.find(v => lower(v).includes('flux') && !lower(v).includes('flux2'))
    if (match) return match
    throw new Error(`No FLUX.1 VAE found. Download "ae.safetensors" from the Model Manager.`)
  }
  if (modelType === 'flux2' || modelType === 'ernie_image') {
    const match = vaes.find(v => lower(v).includes('flux2'))
      || vaes.find(v => lower(v).includes('flux'))
      || vaes.find(v => lower(v).includes('ae'))
    if (match) return match
    throw new Error(`No FLUX 2 VAE found. Download "flux2-vae.safetensors" from the Model Manager.`)
  }
  if (modelType === 'hunyuan') {
    // HunyuanVideo has its own VAE — prefer it, fall back to Wan VAE
    const match = vaes.find(v => lower(v).includes('hunyuanvideo'))
      || vaes.find(v => lower(v).includes('hunyuan'))
      || vaes.find(v => lower(v).includes('wan'))
    if (match) return match
    throw new Error(`No HunyuanVideo VAE found. Download "hunyuanvideo15_vae_fp16.safetensors" from the Model Manager.`)
  }
  if (modelType === 'wan') {
    // Wan 2.1 latents are 16-channel; the Wan 2.2 VAE is 48-channel — decoding
    // 2.1 output with it fails ("expected input to have 48 channels, but got
    // 16"). Live regression 2026-06-11: right after the Wan 2.2 bundle install,
    // wan2.2_vae sorted BEFORE wan_2.1_vae in the enum and the first
    // .includes('wan') hit broke every Wan 2.1 generation. Prefer the 2.1 file
    // explicitly and never fall into a 2.2 one.
    const isWan22Vae = (v: string) => /wan[._]?2[._]?2/.test(lower(v))
    const match = vaes.find(v => /wan[._]?2[._]?1/.test(lower(v)))
      || vaes.find(v => lower(v).includes('wan') && !isWan22Vae(v))
      || vaes.find(v => lower(v).includes('hunyuan'))
    if (match) return match
    throw new Error(`No Wan VAE found. Download "wan_2.1_vae.safetensors" from the Model Manager.`)
  }
  if (modelType === 'wan22') {
    // Defense in depth — the wan22 builder pins its VAE by name, but if this
    // resolver is ever hit, ONLY the 2.2 VAE is valid (48-channel latents).
    const match = vaes.find(v => /wan[._]?2[._]?2/.test(lower(v)))
    if (match) return match
    throw new Error(`No Wan 2.2 VAE found. Download "wan2.2_vae.safetensors" from the Model Manager.`)
  }
  if (modelType === 'ltx') {
    const match = vaes.find(v => lower(v).includes('ltx'))
    if (match) return match
    return vaes[0]
  }
  if (modelType === 'mochi') {
    const match = vaes.find(v => lower(v).includes('mochi'))
    if (match) return match
    throw new Error(`No Mochi VAE found. Download "mochi_vae.safetensors" from the Model Manager.`)
  }
  if (modelType === 'cosmos') {
    const match = vaes.find(v => lower(v).includes('cosmos'))
    if (match) return match
    throw new Error(`No Cosmos VAE found. Download "cosmos_cv8x8x8_1.0.safetensors" from the Model Manager.`)
  }
  if (modelType === 'cogvideo') {
    const match = vaes.find(v => lower(v).includes('cogvideox') || lower(v).includes('cogvideo'))
    if (match) return match
    throw new Error(`No CogVideoX VAE found. Download "cogvideox_vae_bf16.safetensors" from the Model Manager.`)
  }
  if (modelType === 'framepack') {
    const match = vaes.find(v => lower(v).includes('hunyuan') || lower(v).includes('wan'))
    if (match) return match
    throw new Error(`No FramePack VAE found. Download "hunyuanvideo15_vae_fp16.safetensors" from the Model Manager.`)
  }
  if (modelType === 'pyramidflow') {
    const match = vaes.find(v => lower(v).includes('pyramid'))
    if (match) return match
    throw new Error(`No Pyramid Flow VAE found. Download from the Model Manager.`)
  }
  // SVD / Allegro use checkpoint-embedded VAE, SDXL/SD1.5 too — any VAE works as fallback
  return vaes[0]
}

/**
 * Resolve the FLUX v1 text-encoder PAIR for DualCLIPLoader (C2, aldrich
 * follow-up): modern ComfyUI removed 'flux' from the single CLIPLoader's type
 * enum, so FLUX v1 conditioning must come from DualCLIPLoader, which needs
 * BOTH encoders — clip_name1 = T5-XXL, clip_name2 = CLIP-L. Throws the same
 * actionable "download <file> from the Model Manager" errors as
 * findMatchingCLIP so buildDynamicWorkflow surfaces a fix path per missing
 * encoder instead of a raw ComfyUI rejection.
 */
export async function findFluxCLIPPair(): Promise<{ t5: string; clipL: string }> {
  const clips = await getCLIPModels()
  if (clips.length === 0) throw new Error('No text encoder models found. Download a CLIP/T5 model for your model type from the Model Manager.')
  const lower = (s: string) => s.toLowerCase()
  const t5 = clips.find(c => lower(c).includes('t5') && !lower(c).includes('umt5') && !lower(c).includes('oldt5'))
  const clipL = clips.find(c => lower(c).includes('clip_l'))
  if (!t5) throw new Error(`No FLUX text encoder (T5) found. Download "t5xxl_fp8_e4m3fn.safetensors" from the Model Manager.`)
  if (!clipL) throw new Error(`No FLUX CLIP-L text encoder found. Download "clip_l.safetensors" from the Model Manager.`)
  return { t5, clipL }
}

/**
 * Pick the right text encoder for a model.
 *
 * @param modelType — ModelType from `classifyModel`.
 * @param activeModelName — optional filename of the UNet/checkpoint the
 *   user selected. Enables quantisation-aware pairing: e.g. fp4 FLUX 2
 *   models get the fp4-matched Qwen encoder, fp8/bf16 FLUX 2 models get
 *   the full-precision Qwen encoder. When omitted (legacy callers), we
 *   fall back to the full-precision variant, which is what most users
 *   want.
 */
export async function findMatchingCLIP(modelType: ModelType, activeModelName?: string): Promise<string> {
  const clips = await getCLIPModels()
  if (clips.length === 0) throw new Error('No text encoder models found. Download a CLIP/T5 model for your model type from the Model Manager.')
  const lower = (s: string) => s.toLowerCase()
  const modelLc = activeModelName ? lower(activeModelName) : ''
  const modelIsFp4 = /fp4|nf4/.test(modelLc)

  if (modelType === 'zimage') {
    // Z-Image uses qwen_3_4b.safetensors (NOT the fp4_flux2 variant — different embedding dimensions!)
    const match = clips.find(c => lower(c) === 'qwen_3_4b.safetensors')
      || clips.find(c => lower(c).includes('qwen_3_4b') && !lower(c).includes('fp4') && !lower(c).includes('flux2'))
      || clips.find(c => lower(c).includes('qwen3') && !lower(c).includes('fp4'))
    if (match) return match
    throw new Error(`No Z-Image text encoder found. Download "qwen_3_4b.safetensors" from the Model Manager.`)
  }
  if (modelType === 'flux2') {
    // FLUX 2 uses Qwen 3 4B (NOT T5). The encoder file comes in two
    // quantisation tiers that ARE NOT interchangeable:
    //   - `qwen_3_4b.safetensors`           → normal / bf16 / fp8 models
    //   - `qwen_3_4b_fp4_flux2.safetensors` → fp4 / nf4 quantised models
    // Using the wrong one can work (same embedding dim) but noticeably
    // degrades prompt adherence, so we pair them by inspecting the
    // filename of the active UNet (see `modelIsFp4` above). Fallback
    // order ensures we never hard-fail when the "ideal" encoder isn't
    // installed: we try the paired one first, then the other.
    const qwenFp4  = clips.find(c => lower(c).includes('qwen') && (lower(c).includes('fp4') || lower(c).includes('nf4')) && !lower(c).includes('qwen_2.5_vl'))
    const qwenFull = clips.find(c => lower(c).includes('qwen_3_4b') && !lower(c).includes('fp4') && !lower(c).includes('nf4') && !lower(c).includes('vl'))
    const qwenAny  = clips.find(c => lower(c).includes('qwen') && !lower(c).includes('qwen_2.5_vl'))
    const mistral  = clips.find(c => lower(c).includes('mistral'))
    const match = modelIsFp4
      ? (qwenFp4 || qwenFull || qwenAny || mistral)
      : (qwenFull || qwenAny || qwenFp4 || mistral)
    if (match) return match
    const wanted = modelIsFp4 ? 'qwen_3_4b_fp4_flux2.safetensors (fp4 FLUX 2)' : 'qwen_3_4b.safetensors (fp8/bf16 FLUX 2)'
    throw new Error(`No FLUX 2 text encoder found. Download "${wanted}" from the Model Manager.`)
  }
  if (modelType === 'ernie_image') {
    // ERNIE-Image uses its own prompt enhancer text encoder
    const match = clips.find(c => lower(c).includes('ernie-image-prompt-enhancer') || lower(c).includes('ernie'))
    if (match) return match
    throw new Error(`No ERNIE-Image text encoder found. Download "ernie-image-prompt-enhancer.safetensors" from the Model Manager.`)
  }
  if (modelType === 'flux') {
    const match = clips.find(c => lower(c).includes('t5') && !lower(c).includes('umt5'))
      || clips.find(c => lower(c).includes('clip_l'))
    if (match) return match
    throw new Error(`No FLUX text encoder (T5) found. Download "t5xxl_fp8_e4m3fn.safetensors" from the Model Manager.`)
  }
  if (modelType === 'hunyuan') {
    // HunyuanVideo 1.5 uses Qwen 2.5 VL, older versions use llava_llama3
    const match = clips.find(c => lower(c).includes('qwen'))
      || clips.find(c => lower(c).includes('llava'))
      || clips.find(c => lower(c).includes('umt5'))
    if (match) return match
    throw new Error(`No HunyuanVideo text encoder found. Download "qwen_2.5_vl_7b_fp8_scaled.safetensors" from the Model Manager.`)
  }
  if (modelType === 'wan') {
    const match = clips.find(c => lower(c).includes('umt5') || lower(c).includes('wan'))
      || clips.find(c => lower(c).includes('t5'))
    if (match) return match
    throw new Error(`No Wan text encoder found. Download "umt5_xxl_fp8_e4m3fn_scaled.safetensors" from the Model Manager.`)
  }
  if (modelType === 'ltx') {
    const match = clips.find(c => lower(c).includes('gemma'))
    if (match) return match
    throw new Error(`No LTX Video text encoder found. Download "gemma_3_12B_it_fp8_scaled.safetensors" from the Model Manager.`)
  }
  if (modelType === 'mochi') {
    const match = clips.find(c => lower(c).includes('t5') && !lower(c).includes('umt5') && !lower(c).includes('oldt5'))
    if (match) return match
    throw new Error(`No Mochi text encoder found. Download "t5xxl_fp16.safetensors" from the Model Manager.`)
  }
  if (modelType === 'cosmos') {
    // Cosmos uses oldt5, NOT regular t5xxl
    const match = clips.find(c => lower(c).includes('oldt5'))
    if (match) return match
    throw new Error(`No Cosmos text encoder found. Download "oldt5_xxl_fp8_e4m3fn_scaled.safetensors" from the Model Manager.`)
  }
  if (modelType === 'cogvideo') {
    const match = clips.find(c => lower(c).includes('t5') && !lower(c).includes('umt5') && !lower(c).includes('oldt5'))
    if (match) return match
    throw new Error(`No CogVideoX text encoder found. Download "t5xxl_fp16.safetensors" from the Model Manager.`)
  }
  if (modelType === 'framepack') {
    const match = clips.find(c => lower(c).includes('llava') || lower(c).includes('qwen'))
      || clips.find(c => lower(c).includes('umt5'))
    if (match) return match
    throw new Error(`No FramePack text encoder found. Download "llava_llama3_fp8_scaled.safetensors" from the Model Manager.`)
  }
  // SDXL/SD1.5/SVD/Allegro/PyramidFlow checkpoints include CLIP — any works
  return clips[0]
}

async function findAnimateDiffModel(): Promise<string> {
  const models = await getAnimateDiffModels()
  if (models.length === 0) throw new Error('No AnimateDiff motion models found. Install them via ComfyUI Manager.')
  return models[0]
}

// ─── Workflow Submission ───

export async function submitWorkflow(workflow: Record<string, any>, clientId?: string): Promise<string> {
  const payload: Record<string, any> = { prompt: workflow }
  if (clientId) payload.client_id = clientId
  // Use localFetch (Rust proxy in Tauri, direct fetch in dev). The previous
  // direct-only fetch broke for any ComfyUI not started by LU itself —
  // `--enable-cors-header *` is the LU spawn flag, but a user-run ComfyUI
  // Portable / cu126 / AMD build doesn't pass it, so the browser blocks the
  // POST during preflight and the only thing the user sees is the JS error
  // "Failed to fetch". The proxy bypasses the SOP entirely (it's a Rust HTTP
  // call, not a browser one). Bug: GH disc #35, Discord oogletree + reload__.
  const url = comfyuiUrl('/prompt')
  const res = await localFetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
    // /prompt only validates + enqueues and returns the prompt_id immediately —
    // it does NOT block on the render. Cap it so a wedged submit can't strand the
    // VRAM hand-off (text model stays unloaded) for the 5-min proxy default.
    timeoutMs: COMFY_SUBMIT_TIMEOUT_MS,
  })
  if (!res.ok) {
    const rawText = await res.text().catch(() => '')
    let errMsg = `HTTP ${res.status}`
    try {
      const errData = JSON.parse(rawText)
      const parts: string[] = []
      if (typeof errData.error === 'string') parts.push(errData.error)
      else if (errData.error?.message) parts.push(errData.error.message)
      if (errData.node_errors) {
        for (const [nodeId, data] of Object.entries(errData.node_errors) as [string, any][]) {
          const errs = data.errors?.map((e: any) => e.message || e.details).join(', ') || 'unknown'
          parts.push(`Node ${nodeId} (${data.class_type || '?'}): ${errs}`)
        }
      }
      if (parts.length > 0) errMsg = parts.join(' | ')
    } catch {
      if (rawText) errMsg = rawText.slice(0, 500)
    }
    log.error('comfyui.workflow_rejected', { errMsg, workflow: JSON.stringify(workflow).slice(0, 2000) })
    throw new Error(`ComfyUI rejected workflow: ${errMsg}`)
  }
  const data = await res.json()
  return data.prompt_id
}

export async function cancelGeneration(): Promise<void> {
  try {
    await localFetch(comfyuiUrl('/interrupt'), { method: 'POST', timeoutMs: COMFY_STATS_TIMEOUT_MS })
  } catch { /* best effort */ }
}

export async function freeMemory(): Promise<void> {
  try {
    await localFetch(comfyuiUrl('/free'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ unload_models: true, free_memory: true }),
      // Bounded: this runs in the hand-off's `finally` right before reloading the
      // text model. A wedged /free must not delay that reload by 5 min.
      timeoutMs: COMFY_FREE_TIMEOUT_MS,
    })
  } catch { /* best effort */ }
}

export async function getHistory(promptId: string): Promise<any> {
  try {
    // localFetch routes through Rust proxy in Tauri to dodge CORS — same
    // reason as submitWorkflow above. Without this, a user-run ComfyUI
    // Portable would accept the /prompt POST but the polling /history GETs
    // would silently 0-out and the UI hangs in "generating…" forever.
    const res = await localFetch(comfyuiUrl(`/history/${promptId}`), { timeoutMs: COMFY_POLL_TIMEOUT_MS })
    if (!res.ok) return null
    const data = await res.json()
    return data[promptId] ?? null
  } catch {
    return null
  }
}

// ─── Upload image to ComfyUI (for I2V models like SVD, FramePack) ───

export async function uploadImage(file: File): Promise<string> {
  // Guard: ComfyUI's /upload/image answers an opaque HTTP 400 for an empty or
  // unreadable file. Catch the empty-blob case up front with a clear message
  // (konata 2026-06-14: "Video generation failed: Failed to upload image: HTTP 400").
  if (!file || file.size === 0) {
    throw new Error('Failed to upload image: the source image is empty (0 bytes) — it could not be read from ComfyUI.')
  }

  // ComfyUI saves the file under the multipart filename and opens it with PIL by
  // extension, so it 400s on a missing/extension-less/odd name. Send an explicit,
  // sanitised filename with a real image extension rather than trusting file.name
  // (a Blob-derived File can carry "" or an extension-less name).
  const safeName = ensureImageFilename(file.name, file.type)

  // Tauri (packaged): post the multipart from Rust. The raw browser fetch()
  // below was the ONLY non-proxy fetch left in the app, and it 400'd on some
  // WebView2 builds (multipart/boundary/CORS-preflight quirks; konata
  // 2026-06-14 "Failed to upload image: HTTP 400"). reqwest's multipart is
  // machine-independent and removes WebView2 as a variable — matching the
  // "everything via the Rust proxy" pattern (WebView2-149 finding). Dev/browser
  // keeps the direct fetch (Vite proxy / CORS-enabled ComfyUI).
  if (isTauri()) {
    const bytes = Array.from(new Uint8Array(await file.arrayBuffer()))
    let body: string
    try {
      body = await backendCall<string>('comfy_upload_image', {
        url: comfyuiUrl('/upload/image'),
        filename: safeName,
        contentType: file.type || 'image/png',
        fileBytes: bytes,
      })
    } catch (e) {
      // The Rust side rejects with "HTTP <s>: <body>" — surface ComfyUI's
      // actual reason so the dropzone error is self-explanatory.
      throw new Error(`Failed to upload image: ${e instanceof Error ? e.message : String(e)}`)
    }
    const data = JSON.parse(body)
    return data.name // ComfyUI returns { name, subfolder, type }
  }

  const formData = new FormData()
  formData.append('image', file, safeName)
  formData.append('overwrite', 'true')

  // Direct fetch — localFetch only supports string body, not FormData.
  // FormData needs multipart/form-data which fetch() sets automatically. A 400
  // here means the request reached ComfyUI and it rejected the content, so the
  // proxy/CORS is not at fault — surface ComfyUI's actual reason instead of a
  // bare status so the next failure is self-explanatory.
  const res = await fetch(comfyuiUrl('/upload/image'), {
    method: 'POST',
    body: formData,
  })
  if (!res.ok) {
    let detail = ''
    try { detail = (await res.text()).trim() } catch { /* body empty / already consumed */ }
    throw new Error(`Failed to upload image: HTTP ${res.status}${detail ? ` — ${detail.slice(0, 300)}` : ''}`)
  }
  const data = await res.json()
  return data.name // ComfyUI returns { name, subfolder, type }
}

/** Ensure a ComfyUI-friendly image filename: a sane base plus a real image
 *  extension inferred from the MIME type when the name lacks one. ComfyUI's
 *  /upload/image needs a recognisable extension to open the file with PIL. */
export function ensureImageFilename(name: string | undefined, mime: string | undefined): string {
  const base = (name || '').replace(/^.*[\\/]/, '').trim()
  if (base && /\.(png|jpe?g|webp|gif|bmp|tiff?)$/i.test(base)) return base
  const ext = ((m) => {
    switch ((m || '').toLowerCase()) {
      case 'image/jpeg': return 'jpg'
      case 'image/webp': return 'webp'
      case 'image/gif': return 'gif'
      case 'image/bmp': return 'bmp'
      case 'image/tiff': return 'tiff'
      default: return 'png'
    }
  })(mime)
  const stem = (base ? base.replace(/\.[^.]*$/, '') : 'lu_input') || 'lu_input'
  const safeStem = stem.replace(/[^A-Za-z0-9._-]+/g, '_').slice(0, 64) || 'lu_input'
  return `${safeStem}.${ext}`
}

export function getImageUrl(filename: string, subfolder: string = '', type: string = 'output', cacheBust?: string | number): string {
  const path = `/view?filename=${encodeURIComponent(filename)}&subfolder=${encodeURIComponent(subfolder)}&type=${type}`
  // A cache-buster is appended ONLY when an explicit, STABLE token is supplied
  // (e.g. a gallery item's immutable `createdAt`). We must never mint a fresh
  // `Date.now()` per call: that returned a different URL on every React
  // re-render, forcing the <img>/<video> to refetch mid-render — which is
  // exactly what made the media viewer flicker while zooming/panning/loading.
  // ComfyUI output filenames are unique per generation, so a per-item token is
  // sufficient to defeat any rare filename-reuse cache collision.
  return comfyuiUrl(cacheBust != null ? `${path}&t=${cacheBust}` : path)
}

/**
 * Fetch a ComfyUI /view image URL and return it base64-encoded (no data: prefix)
 * so it can be handed to a vision-capable chat model as an `images` attachment.
 * Used by the chat-agent vision feedback loop: after image_generate, the model
 * SEES the picture it made and can comment on it.
 */
export async function fetchComfyImageBase64(url: string): Promise<string> {
  const bytes = await fetchLocalhostBytes(url)
  let binary = ''
  const CHUNK = 0x8000 // avoid arg-count limits on String.fromCharCode
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK) as unknown as number[])
  }
  return btoa(binary)
}

// ─── Validate params ───
//
// LEGACY static bounds (steps 1-200 / frames 1-256). The chat-agent path
// (vram-handoff → buildDynamicWorkflow) now validates against REAL per-model
// limits via getModelCapabilities() in comfyui-nodes.ts and rejects-and-reports
// over-limit requests (decision 2). These hard bounds remain only for the legacy
// static workflow builders below (buildSDXLImgWorkflow / buildFluxImgWorkflow /
// buildWanVideoWorkflow); new validation must use getModelCapabilities.

function validateParams(params: GenerateParams) {
  if (!params.prompt.trim()) throw new Error('Prompt is empty')
  if (!params.model) throw new Error('No model selected')
  if (params.width < 64 || params.width > 4096) throw new Error('Width must be 64-4096')
  if (params.height < 64 || params.height > 4096) throw new Error('Height must be 64-4096')
  if (params.steps < 1 || params.steps > 200) throw new Error('Steps must be 1-200')
}

function validateVideoParams(params: VideoParams) {
  validateParams(params)
  if (params.frames < 1 || params.frames > 256) throw new Error('Frames must be 1-256')
  if (params.fps < 1 || params.fps > 60) throw new Error('FPS must be 1-60')
  // Wan requires width/height to be multiples of 16
  if (params.width % 16 !== 0) throw new Error(`Width must be a multiple of 16 (current: ${params.width})`)
  if (params.height % 16 !== 0) throw new Error(`Height must be a multiple of 16 (current: ${params.height})`)
}

function getSeed(seed: number): number {
  return seed === -1 ? Math.floor(Math.random() * 2147483647) : Math.floor(seed)
}

// ─── Snap video dimensions to valid values ───

export function snapToVideoGrid(width: number, height: number): { width: number; height: number } {
  return {
    width: Math.round(width / 16) * 16,
    height: Math.round(height / 16) * 16,
  }
}

// ─── Image Workflow: SDXL/SD (CheckpointLoaderSimple) ───

export function buildSDXLImgWorkflow(params: GenerateParams): Record<string, any> {
  validateParams(params)
  const seed = getSeed(params.seed)
  return {
    '1': { class_type: 'CheckpointLoaderSimple', inputs: { ckpt_name: params.model } },
    '2': { class_type: 'CLIPTextEncode', inputs: { text: params.prompt, clip: ['1', 1] } },
    '3': { class_type: 'CLIPTextEncode', inputs: { text: params.negativePrompt || '', clip: ['1', 1] } },
    '4': { class_type: 'EmptyLatentImage', inputs: { width: params.width, height: params.height, batch_size: params.batchSize } },
    '5': {
      class_type: 'KSampler',
      inputs: {
        model: ['1', 0], positive: ['2', 0], negative: ['3', 0], latent_image: ['4', 0],
        seed, steps: params.steps, cfg: params.cfgScale,
        sampler_name: params.sampler, scheduler: params.scheduler, denoise: 1.0,
      },
    },
    '6': { class_type: 'VAEDecode', inputs: { samples: ['5', 0], vae: ['1', 2] } },
    '7': { class_type: 'SaveImage', inputs: { images: ['6', 0], filename_prefix: 'locally_uncensored' } },
  }
}

// ─── Image Workflow: FLUX (UNETLoader + CLIPLoader + VAELoader) ───

export async function buildFluxImgWorkflow(params: GenerateParams): Promise<Record<string, any>> {
  validateParams(params)
  const seed = getSeed(params.seed)
  const modelType = classifyModel(params.model)
  const vae = await findMatchingVAE(modelType)
  const clip = await findMatchingCLIP(modelType)
  const clipType = modelType === 'flux2' ? 'flux2' : 'flux'

  const latentNode = modelType === 'flux2' ? 'EmptyFlux2LatentImage' : 'EmptySD3LatentImage'

  return {
    '1': { class_type: 'UNETLoader', inputs: { unet_name: params.model, weight_dtype: 'default' } },
    '2': { class_type: 'CLIPLoader', inputs: { clip_name: clip, type: clipType, device: 'default' } },
    '3': { class_type: 'VAELoader', inputs: { vae_name: vae } },
    '4': { class_type: 'CLIPTextEncode', inputs: { text: params.prompt, clip: ['2', 0] } },
    '5': { class_type: 'CLIPTextEncode', inputs: { text: '', clip: ['2', 0] } },
    '6': { class_type: latentNode, inputs: { width: params.width, height: params.height, batch_size: params.batchSize } },
    '7': {
      class_type: 'KSampler',
      inputs: {
        model: ['1', 0], positive: ['4', 0], negative: ['5', 0], latent_image: ['6', 0],
        seed, steps: params.steps, cfg: params.cfgScale,
        sampler_name: params.sampler, scheduler: params.scheduler, denoise: 1.0,
      },
    },
    '8': { class_type: 'VAEDecode', inputs: { samples: ['7', 0], vae: ['3', 0] } },
    '9': { class_type: 'SaveImage', inputs: { images: ['8', 0], filename_prefix: 'locally_uncensored' } },
  }
}

// ─── Auto-select Image Workflow ───

export async function buildTxt2ImgWorkflow(params: GenerateParams, modelType: ModelType): Promise<Record<string, any>> {
  if (modelType === 'flux' || modelType === 'flux2') return buildFluxImgWorkflow(params)
  return buildSDXLImgWorkflow(params)
}

// ─── Video Workflow: Wan 2.1/2.2 (Hunyuan latent space) ───

export async function buildWanVideoWorkflow(params: VideoParams): Promise<Record<string, any>> {
  validateVideoParams(params)
  const seed = getSeed(params.seed)

  // Pre-check required nodes
  const hasLatent = await nodeExists('EmptyHunyuanLatentVideo')
  if (!hasLatent) throw new Error('EmptyHunyuanLatentVideo node not found. Update ComfyUI to latest version.')
  const hasSaveWEBP = await nodeExists('SaveAnimatedWEBP')

  const vae = await findMatchingVAE('wan')
  const clip = await findMatchingCLIP('wan')

  const workflow: Record<string, any> = {
    '1': { class_type: 'CLIPLoader', inputs: { clip_name: clip, type: 'wan', device: 'default' } },
    '2': { class_type: 'UNETLoader', inputs: { unet_name: params.model, weight_dtype: 'default' } },
    '3': { class_type: 'VAELoader', inputs: { vae_name: vae } },
    '4': { class_type: 'CLIPTextEncode', inputs: { text: params.prompt, clip: ['1', 0] } },
    '5': { class_type: 'CLIPTextEncode', inputs: { text: params.negativePrompt || 'static, blurred, low quality, worst quality, deformed', clip: ['1', 0] } },
    '6': { class_type: 'EmptyHunyuanLatentVideo', inputs: { width: params.width, height: params.height, length: params.frames, batch_size: 1 } },
    '7': {
      class_type: 'KSampler',
      inputs: {
        model: ['2', 0], positive: ['4', 0], negative: ['5', 0], latent_image: ['6', 0],
        seed, steps: params.steps, cfg: params.cfgScale,
        sampler_name: params.sampler, scheduler: params.scheduler, denoise: 1.0,
      },
    },
    '8': { class_type: 'VAEDecode', inputs: { samples: ['7', 0], vae: ['3', 0] } },
  }

  // Use SaveAnimatedWEBP if available, otherwise fall back to SaveImage (frame
  // sequence). Prompt-based prefix (David 2026-06-11) — the dynamic builder got
  // this in c40d13f, this legacy T2V path still wrote locally_uncensored_vid.
  const { promptFilenamePrefix } = await import('./dynamic-workflow')
  const vidPrefix = promptFilenamePrefix(params.prompt, true)
  if (hasSaveWEBP) {
    workflow['9'] = {
      class_type: 'SaveAnimatedWEBP',
      inputs: { images: ['8', 0], filename_prefix: vidPrefix, fps: params.fps, lossless: false, quality: 90, method: 'default' },
    }
  } else {
    workflow['9'] = {
      class_type: 'SaveImage',
      inputs: { images: ['8', 0], filename_prefix: vidPrefix },
    }
  }

  return workflow
}

// ─── Video Workflow: AnimateDiff ───

export async function buildAnimateDiffWorkflow(params: VideoParams): Promise<Record<string, any>> {
  validateVideoParams(params)
  const seed = getSeed(params.seed)
  const motionModel = await findAnimateDiffModel()

  // AnimateDiff: batch_size=1, motion model handles temporal dimension
  const hasVHS = await nodeExists('VHS_VideoCombine')

  const workflow: Record<string, any> = {
    '1': { class_type: 'CheckpointLoaderSimple', inputs: { ckpt_name: params.model } },
    '2': { class_type: 'ADE_LoadAnimateDiffModel', inputs: { model_name: motionModel } },
    '3': { class_type: 'ADE_ApplyAnimateDiffModelSimple', inputs: { motion_model: ['2', 0] } },
    '4': { class_type: 'ADE_UseEvolvedSampling', inputs: { model: ['1', 0], m_models: ['3', 0], beta_schedule: 'autoselect' } },
    '5': { class_type: 'CLIPTextEncode', inputs: { text: params.prompt, clip: ['1', 1] } },
    '6': { class_type: 'CLIPTextEncode', inputs: { text: params.negativePrompt || 'low quality, blurry, static', clip: ['1', 1] } },
    '7': { class_type: 'EmptyLatentImage', inputs: { width: params.width, height: params.height, batch_size: params.frames } },
    '8': {
      class_type: 'KSampler',
      inputs: {
        model: ['4', 0], positive: ['5', 0], negative: ['6', 0], latent_image: ['7', 0],
        seed, steps: params.steps, cfg: params.cfgScale,
        sampler_name: params.sampler, scheduler: params.scheduler, denoise: 1.0,
      },
    },
    '9': { class_type: 'VAEDecode', inputs: { samples: ['8', 0], vae: ['1', 2] } },
  }

  // Use VHS_VideoCombine if available (produces MP4), otherwise SaveAnimatedWEBP, otherwise SaveImage
  if (hasVHS) {
    workflow['10'] = {
      class_type: 'VHS_VideoCombine',
      inputs: { images: ['9', 0], frame_rate: params.fps, loop_count: 0, filename_prefix: 'locally_uncensored_vid', format: 'video/h264-mp4', pingpong: false, save_output: true },
    }
  } else {
    const hasSaveWEBP = await nodeExists('SaveAnimatedWEBP')
    if (hasSaveWEBP) {
      workflow['10'] = {
        class_type: 'SaveAnimatedWEBP',
        inputs: { images: ['9', 0], filename_prefix: 'locally_uncensored_vid', fps: params.fps, lossless: false, quality: 90, method: 'default' },
      }
    } else {
      workflow['10'] = {
        class_type: 'SaveImage',
        inputs: { images: ['9', 0], filename_prefix: 'locally_uncensored_vid' },
      }
    }
  }

  return workflow
}

// ─── Auto-select Video Workflow ───

export async function buildTxt2VidWorkflow(params: VideoParams, backend: VideoBackend): Promise<Record<string, any>> {
  switch (backend) {
    case 'wan': return buildWanVideoWorkflow(params)
    case 'animatediff': return buildAnimateDiffWorkflow(params)
    default: throw new Error('No video backend available. Install Wan 2.1 models or AnimateDiff nodes in ComfyUI.')
  }
}
