import { classifyModel, findMatchingVAE, findMatchingCLIP, findFluxCLIPPair } from './comfyui'
import type { ModelType, GenerateParams, VideoParams } from './comfyui'
import { log } from '../lib/logger'
import {
  getAllNodeInfo,
  categorizeNodes,
  detectAvailableModels,
  type CategorizedNodes,
  type AvailableModels,
} from './comfyui-nodes'

// ─── Output filename slug (David 2026-06-11) ───
//
// Generated media used to be `locally_uncensored_00123_.png` /
// `locally_uncensored_vid_00011.mp4` — opaque. Now the ComfyUI SaveImage /
// VHS `filename_prefix` is derived from the PROMPT, so a file is
// `red_apple_on_white_plate_00001_.png`. That makes the result string
// self-descriptive, so a follow-up "animate the red-apple image" can pass the
// recognisable filename straight back. ComfyUI still appends its own
// `_NNNNN_` counter, so uniqueness is preserved.
//
// Exported + pure for the unit tests.
export function promptFilenamePrefix(prompt: string | undefined, isVideo: boolean): string {
  const slug = (prompt || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .split('_')
    .filter(Boolean)
    .slice(0, 6)          // first ~6 words keep it readable
    .join('_')
    .slice(0, 48)
    .replace(/_+$/g, '')
  if (!slug) return isVideo ? 'locally_uncensored_vid' : 'locally_uncensored'
  // Keep a short tag so a folder full of generations is still recognisably ours
  // and videos never collide with the still they were made from.
  return isVideo ? `${slug}__vid` : slug
}

// ─── Strategy Detection ───

export type WorkflowStrategy =
  | 'unet_flux'       // FLUX 1: UNETLoader + CLIPLoader + VAELoader + EmptySD3LatentImage
  | 'unet_flux2'      // FLUX 2: UNETLoader + CLIPLoader + VAELoader + EmptyFlux2LatentImage
  | 'unet_zimage'     // Z-Image: UNETLoader + CLIPLoader(qwen_image) + VAELoader + EmptySD3LatentImage
  | 'unet_ernie_image' // ERNIE-Image: UNETLoader + CLIPLoader(flux2) + VAELoader + EmptyFlux2LatentImage + ConditioningZeroOut
  | 'unet_video'      // Wan/Hunyuan: UNETLoader + CLIPLoader + VAELoader + EmptyHunyuanLatentVideo
  | 'wan22'           // Wan 2.2 TI2V-5B: UNET + CLIP + Wan 2.2 VAE + Wan22ImageToVideoLatent (unified T2V/I2V)
  | 'unet_ltx'        // LTX Video: UNETLoader + CLIPLoader + EmptyLTXVLatentVideo
  | 'unet_mochi'      // Mochi: UNETLoader + CLIPLoader + VAELoader + EmptyMochiLatentVideo
  | 'unet_cosmos'     // Cosmos: UNETLoader + CLIPLoader(oldt5) + VAELoader + EmptyCosmosLatentVideo
  | 'svd'             // SVD: ImageOnlyCheckpointLoader + SVD_img2vid_Conditioning
  | 'cogvideo'        // CogVideoX: Kijai wrapper nodes
  | 'framepack'       // FramePack: Kijai wrapper + image input
  | 'pyramidflow'     // Pyramid Flow: Kijai wrapper nodes
  | 'allegro'         // Allegro: Community wrapper nodes
  | 'checkpoint'      // SDXL/SD1.5: CheckpointLoaderSimple + EmptyLatentImage
  | 'animatediff'     // AnimateDiff: CheckpointLoaderSimple + ADE_* nodes
  | 'unavailable'

interface StrategyResult {
  strategy: WorkflowStrategy
  reason: string
  /**
   * When `strategy === 'unavailable'` and the missing piece is an
   * installable custom-node pack, this hint tells the UI which one to
   * suggest. Surfaces in Create view as a clickable "open install guide"
   * link so users like vvvxxxvvv_80435 (CogVideoX 1.5 5B → UNETLoader
   * mismatch on v2.4.3) get a clear next step instead of just a
   * blocking error. (Bug #6)
   */
  installHint?: { pack: string; url: string }
}

export function determineStrategy(
  modelType: ModelType,
  isVideo: boolean,
  nodes: CategorizedNodes,
  models: AvailableModels,
): StrategyResult {
  const hasUNET = nodes.loaders.includes('UNETLoader')
  const hasCheckpoint = nodes.loaders.includes('CheckpointLoaderSimple')
  const hasCLIPLoader = nodes.loaders.includes('CLIPLoader')
  const hasVAELoader = nodes.loaders.includes('VAELoader')
  const hasAnimateDiff = nodes.motion.includes('ADE_LoadAnimateDiffModel')

  // ERNIE-Image → UNET + CLIPLoader(flux2) + VAE + Flux2LatentImage + ConditioningZeroOut
  if (modelType === 'ernie_image') {
    if (hasUNET && hasCLIPLoader && hasVAELoader) {
      return { strategy: 'unet_ernie_image', reason: 'ERNIE-Image model → UNETLoader + CLIPLoader(flux2) + ConditioningZeroOut' }
    }
    return { strategy: 'unavailable', reason: 'ERNIE-Image requires UNETLoader + CLIPLoader + VAELoader nodes' }
  }

  // Z-Image → UNET + CLIPLoader(qwen_image) + VAE + SD3LatentImage
  if (modelType === 'zimage') {
    if (hasUNET && hasCLIPLoader && hasVAELoader) {
      return { strategy: 'unet_zimage', reason: 'Z-Image model → UNETLoader + CLIPLoader(qwen_image)' }
    }
    return { strategy: 'unavailable', reason: 'Z-Image requires UNETLoader + CLIPLoader + VAELoader nodes' }
  }

  // FLUX 2 → UNET + Flux2LatentImage
  if (modelType === 'flux2') {
    if (hasUNET && hasCLIPLoader && hasVAELoader) {
      return { strategy: 'unet_flux2', reason: 'FLUX 2 model → UNETLoader + EmptyFlux2LatentImage' }
    }
    return { strategy: 'unavailable', reason: 'FLUX 2 requires UNETLoader + CLIPLoader + VAELoader nodes' }
  }

  // FLUX 1 → UNET + SD3LatentImage
  if (modelType === 'flux') {
    if (hasUNET && hasCLIPLoader && hasVAELoader) {
      return { strategy: 'unet_flux', reason: 'FLUX model → UNETLoader pipeline' }
    }
    return { strategy: 'unavailable', reason: 'FLUX requires UNETLoader + CLIPLoader + VAELoader nodes' }
  }

  // LTX Video → UNET + LTXVLatentVideo (no separate VAE needed)
  if (modelType === 'ltx') {
    if (hasUNET && hasCLIPLoader) {
      return { strategy: 'unet_ltx', reason: 'LTX Video → UNETLoader + EmptyLTXVLatentVideo' }
    }
    return { strategy: 'unavailable', reason: 'LTX Video requires UNETLoader + CLIPLoader nodes' }
  }

  // Wan 2.2 TI2V-5B → UNET + CLIP + Wan 2.2 VAE + Wan22ImageToVideoLatent (T2V & I2V)
  if (modelType === 'wan22') {
    const hasWan22Latent = nodes.latentInit.includes('Wan22ImageToVideoLatent')
    if (hasUNET && hasCLIPLoader && hasVAELoader && hasWan22Latent) {
      return { strategy: 'wan22', reason: 'Wan 2.2 TI2V-5B → UNETLoader + Wan22ImageToVideoLatent (unified T2V/I2V)' }
    }
    return {
      strategy: 'unavailable',
      reason: 'Wan 2.2 TI2V-5B needs the Wan22ImageToVideoLatent node (ComfyUI ≥ v0.3.46). Update ComfyUI, then try again.',
    }
  }

  // Wan / Hunyuan → UNET-based with video latent
  if (modelType === 'wan' || modelType === 'hunyuan') {
    if (hasUNET && hasCLIPLoader && hasVAELoader) {
      return { strategy: 'unet_video', reason: `${modelType} model → UNETLoader + video latent` }
    }
    return { strategy: 'unavailable', reason: 'Wan/Hunyuan requires UNETLoader + CLIPLoader + VAELoader nodes' }
  }

  // Mochi → UNET + EmptyMochiLatentVideo (native)
  if (modelType === 'mochi') {
    if (hasUNET && hasCLIPLoader && hasVAELoader) {
      return { strategy: 'unet_mochi', reason: 'Mochi → UNETLoader + EmptyMochiLatentVideo' }
    }
    return { strategy: 'unavailable', reason: 'Mochi requires UNETLoader + CLIPLoader + VAELoader nodes' }
  }

  // Cosmos → UNET + EmptyCosmosLatentVideo (native, oldt5 encoder)
  if (modelType === 'cosmos') {
    if (hasUNET && hasCLIPLoader && hasVAELoader) {
      return { strategy: 'unet_cosmos', reason: 'Cosmos → UNETLoader + EmptyCosmosLatentVideo (oldt5)' }
    }
    return { strategy: 'unavailable', reason: 'Cosmos requires UNETLoader + CLIPLoader + VAELoader nodes' }
  }

  // SVD → ImageOnlyCheckpointLoader (native, I2V)
  if (modelType === 'svd') {
    const hasIOCL = nodes.loaders.includes('ImageOnlyCheckpointLoader')
    if (hasIOCL) {
      return { strategy: 'svd', reason: 'SVD → ImageOnlyCheckpointLoader + SVD_img2vid_Conditioning' }
    }
    return { strategy: 'unavailable', reason: 'SVD requires ImageOnlyCheckpointLoader node' }
  }

  // CogVideoX → Kijai wrapper nodes
  if (modelType === 'cogvideo') {
    const hasCogNodes = nodes.samplers.includes('CogVideoXSampler')
    if (hasCogNodes) {
      return { strategy: 'cogvideo', reason: 'CogVideoX → Kijai wrapper pipeline' }
    }
    return {
      strategy: 'unavailable',
      reason: 'CogVideoX needs the ComfyUI-CogVideoXWrapper custom nodes. Install via ComfyUI Manager (Manager → Install Custom Nodes → search "CogVideoXWrapper") or git clone the repo into ComfyUI/custom_nodes/.',
      installHint: { pack: 'ComfyUI-CogVideoXWrapper', url: 'https://github.com/kijai/ComfyUI-CogVideoXWrapper' },
    }
  }

  // FramePack → Kijai wrapper nodes (I2V)
  if (modelType === 'framepack') {
    const hasFPNodes = nodes.samplers.includes('FramePackSampler')
    if (hasFPNodes) {
      return { strategy: 'framepack', reason: 'FramePack → Kijai wrapper pipeline (I2V)' }
    }
    return {
      strategy: 'unavailable',
      reason: 'FramePack needs the ComfyUI-FramePackWrapper custom nodes. Install via ComfyUI Manager (Manager → Install Custom Nodes → search "FramePackWrapper") or git clone the repo into ComfyUI/custom_nodes/.',
      installHint: { pack: 'ComfyUI-FramePackWrapper', url: 'https://github.com/kijai/ComfyUI-FramePackWrapper' },
    }
  }

  // Pyramid Flow → Kijai wrapper nodes
  if (modelType === 'pyramidflow') {
    const hasPFNodes = nodes.samplers.includes('PyramidFlowSampler')
    if (hasPFNodes) {
      return { strategy: 'pyramidflow', reason: 'Pyramid Flow → Kijai wrapper pipeline' }
    }
    return {
      strategy: 'unavailable',
      reason: 'Pyramid Flow needs the ComfyUI-PyramidFlowWrapper custom nodes. Install via ComfyUI Manager or git clone into ComfyUI/custom_nodes/.',
      installHint: { pack: 'ComfyUI-PyramidFlowWrapper', url: 'https://github.com/kijai/ComfyUI-PyramidFlowWrapper' },
    }
  }

  // Allegro → Community wrapper nodes
  if (modelType === 'allegro') {
    const hasAllegroNodes = nodes.samplers.includes('AllegroSampler')
    if (hasAllegroNodes) {
      return { strategy: 'allegro', reason: 'Allegro → Community wrapper pipeline' }
    }
    return {
      strategy: 'unavailable',
      reason: 'Allegro needs the ComfyUI-Allegro community wrapper nodes (search "Allegro" in ComfyUI Manager → Install Custom Nodes).',
      installHint: { pack: 'ComfyUI-Allegro', url: 'https://github.com/rhajou/ComfyUI-Allegro' },
    }
  }

  // SDXL / SD1.5 / Unknown
  if (isVideo && hasAnimateDiff && hasCheckpoint && models.motionModels.length > 0) {
    return { strategy: 'animatediff', reason: 'Video mode → AnimateDiff pipeline' }
  }

  if (hasCheckpoint) {
    return { strategy: 'checkpoint', reason: 'Checkpoint-based pipeline' }
  }

  // Last resort: try UNET if available
  if (hasUNET && hasCLIPLoader && hasVAELoader) {
    return { strategy: 'unet_flux', reason: 'Fallback to UNETLoader (no checkpoint loader)' }
  }

  return { strategy: 'unavailable', reason: 'No compatible loader nodes found in ComfyUI' }
}

// ─── Dynamic Workflow Builder ───

/**
 * Custom Error thrown by `buildDynamicWorkflow` when the active ComfyUI
 * lacks the loader nodes for the chosen model architecture (Bug #6:
 * CogVideoX 1.5 / LTX / FramePack require Kijai wrapper nodes that aren't
 * in ComfyUI core). UI can read `.installHint` to render a one-click
 * "open install guide" link instead of just blocking the user.
 */
export class WorkflowUnavailableError extends Error {
  readonly strategy: WorkflowStrategy
  readonly installHint?: { pack: string; url: string }
  constructor(message: string, strategy: WorkflowStrategy, installHint?: { pack: string; url: string }) {
    super(message)
    this.name = 'WorkflowUnavailableError'
    this.strategy = strategy
    this.installHint = installHint
  }
}

/**
 * Probe ComfyUI for the video output node we need. When neither VHS nor
 * SaveAnimatedWEBP is present, the workflow will fall back to SaveImage
 * (single frames on disk) — Turbulent_Tomato7559's "videos generate as
 * .webp" was caused by VHS missing while SaveAnimatedWEBP still produced
 * an animated still. UI calls this BEFORE Generate so users see a banner
 * rather than discovering after the fact.
 */
export async function checkVideoOutputCapability(): Promise<{ mp4Capable: boolean; webpOnly: boolean; missingNodes: string[] }> {
  const allNodes = await getAllNodeInfo()
  const cats = categorizeNodes(allNodes)
  const hasVHS = cats.videoSavers.includes('VHS_VideoCombine')
  const hasWebp = cats.videoSavers.includes('SaveAnimatedWEBP')
  const missing: string[] = []
  if (!hasVHS) missing.push('VHS_VideoCombine (ComfyUI-VideoHelperSuite)')
  return {
    mp4Capable: hasVHS,
    webpOnly: !hasVHS && hasWebp,
    missingNodes: missing,
  }
}

/** Multi-LoRA (konata 2026-06-09) — normalize the `lora` param into an
 *  ordered list. Accepts a single filename, an array, or a comma/semicolon-
 *  joined string (the most common LLM shape for "use lora A and lora B" —
 *  exactly the failing case where the joined string used to reach ComfyUI
 *  verbatim and die with an opaque "Value not in list"). */
export function normalizeLoraList(lora: string | string[] | undefined): string[] {
  if (!lora) return []
  const arr = Array.isArray(lora) ? lora : lora.split(/[,;]+/)
  return arr.map((s) => (typeof s === 'string' ? s.trim() : '')).filter(Boolean)
}

/** One strength per LoRA: a single number applies to all, an array maps by
 *  index (missing/invalid entries fall back to 0.8). No range clamp — the
 *  LoraLoader node itself owns its real min/max (no magic numbers here);
 *  only non-finite garbage is replaced. */
export function normalizeLoraStrengths(
  strength: number | number[] | undefined,
  count: number,
): number[] {
  const fallback = 0.8
  const sane = (v: unknown): number =>
    typeof v === 'number' && Number.isFinite(v) ? v : fallback
  if (typeof strength === 'number') return Array(count).fill(sane(strength))
  if (Array.isArray(strength)) return Array.from({ length: count }, (_, i) => sane(strength[i]))
  return Array(count).fill(fallback)
}

/** Resolve requested LoRA names against ComfyUI's installed LoraLoader enum.
 *  Per name: exact → normalized (case/extension/path-separator insensitive)
 *  → basename → unique substring. A miss throws an actionable error listing
 *  what IS installed (same pattern as the Fix-C encoder hint) instead of
 *  letting ComfyUI reject the whole workflow with "Value not in list". */
export function resolveLoraNames(requested: string[], installed: string[]): string[] {
  return requested.map((req) => {
    const hit = resolveOneLora(req, installed)
    if (!hit) {
      const list = installed.length ? installed.slice(0, 12).join(', ') : '(none installed)'
      throw new Error(
        `LoRA "${req}" is not installed in ComfyUI. Installed LoRAs: ${list}. ` +
        `Put the .safetensors file into ComfyUI/models/loras and retry, or drop the lora setting.`,
      )
    }
    return hit
  })
}

function resolveOneLora(req: string, installed: string[]): string | null {
  if (installed.includes(req)) return req
  const norm = (s: string) =>
    s.toLowerCase().replace(/\.(safetensors|pt|ckpt|bin)$/i, '').replace(/\\/g, '/')
  // Separator-insensitive form: users/LLMs say "pixel art" for
  // "pixel-art-xl.safetensors" — spaces, dashes and underscores all collapse.
  const loose = (s: string) => norm(s).replace(/[-_\s]+/g, '')
  const rq = norm(req)
  let hits = installed.filter((c) => norm(c) === rq)
  if (hits.length === 1) return hits[0]
  // Enum entries can be "subfolder/name.safetensors" — try basename equality.
  const rqBase = rq.split('/').pop() || rq
  hits = installed.filter((c) => (norm(c).split('/').pop() || '') === rqBase)
  if (hits.length === 1) return hits[0]
  // Unique substring either way round (separator-insensitive).
  const rqLoose = loose(req)
  hits = installed.filter((c) => loose(c).includes(rqLoose) || rqLoose.includes(loose(c)))
  if (hits.length === 1) return hits[0]
  return null
}

export async function buildDynamicWorkflow(
  params: GenerateParams | VideoParams,
  modelType?: ModelType,
): Promise<Record<string, any>> {
  const type = modelType || classifyModel(params.model)
  const isVideo = 'frames' in params
  const videoParams = params as VideoParams

  // Fetch node info (cached)
  const allNodes = await getAllNodeInfo()
  const nodes = categorizeNodes(allNodes)
  const models = detectAvailableModels(allNodes)

  const { strategy, reason, installHint } = determineStrategy(type, isVideo, nodes, models)
  log.info(`[dynamic-workflow] Strategy: ${strategy} (${reason})`)

  if (strategy === 'unavailable') {
    throw new WorkflowUnavailableError(reason, strategy, installHint)
  }

  const seed = params.seed === -1 ? Math.floor(Math.random() * 2147483647) : params.seed

  // ─── Wrapper Strategies (custom node pipelines — completely different node chains) ───

  if (strategy === 'cogvideo') {
    return buildCogVideoWorkflow(params as VideoParams, seed, nodes)
  }
  if (strategy === 'svd') {
    return buildSVDWorkflow(params as VideoParams, seed, nodes)
  }
  if (strategy === 'wan22') {
    return buildWan22Workflow(params as VideoParams, seed, nodes)
  }
  if (strategy === 'framepack') {
    return buildFramePackWorkflow(params as VideoParams, seed, nodes)
  }
  if (strategy === 'pyramidflow') {
    return buildPyramidFlowWorkflow(params as VideoParams, seed, nodes)
  }
  if (strategy === 'allegro') {
    return buildAllegroWorkflow(params as VideoParams, seed, nodes)
  }

  // ─── Standard Strategies (UNET/Checkpoint → CLIP → Latent → KSampler → VAEDecode) ───

  const workflow: Record<string, any> = {}
  let n = 1 // node counter

  // ─── Phase 1: Model Loading ───

  let modelNodeId: string
  let clipSourceId: string
  let clipOutputSlot: number
  let vaeSourceId: string
  let vaeOutputSlot: number
  let samplerModelId: string

  if (strategy === 'checkpoint') {
    // Single loader: outputs MODEL (0), CLIP (1), VAE (2)
    modelNodeId = String(n++)
    workflow[modelNodeId] = {
      class_type: 'CheckpointLoaderSimple',
      inputs: { ckpt_name: params.model },
    }
    clipSourceId = modelNodeId
    clipOutputSlot = 1
    vaeSourceId = modelNodeId
    vaeOutputSlot = 2
    samplerModelId = modelNodeId

  } else if (strategy === 'unet_flux' || strategy === 'unet_flux2' || strategy === 'unet_zimage' || strategy === 'unet_ernie_image' || strategy === 'unet_video' || strategy === 'unet_ltx'
    || strategy === 'unet_mochi' || strategy === 'unet_cosmos') {
    // Separate loaders
    const unetId = String(n++)
    const clipId = String(n++)

    const clipType = type === 'zimage' ? 'qwen_image'
      : type === 'ernie_image' ? 'flux2'
      : type === 'flux2' ? 'flux2'
      : type === 'flux' ? 'flux'
      : type === 'ltx' ? 'ltxv'
      : (type === 'wan' || type === 'hunyuan') ? 'wan'
      : type === 'mochi' ? 'mochi'
      : type === 'cosmos' ? 'cosmos'
      : 'flux'

    // Resolve the text encoder from the LIVE ComfyUI node enum. CRITICAL
    // (Bug C / aldrich "CLIPLoader: Value not in list"): do NOT silently fall
    // back to models.clips[0] / '' on a miss — an empty or wrong clip_name makes
    // ComfyUI reject the prompt with that exact cryptic error. The resolvers
    // throw actionable "download <encoder>" messages; propagate them as a
    // WorkflowUnavailableError so the user gets the download hint instead of a
    // raw rejection. Pass the active UNet filename so the resolver prefers the
    // matching quant tier (fp4 model → fp4 encoder; fp8/bf16 → full precision).
    //
    // C2 (aldrich follow-up, v2.5.3 fix #5): modern ComfyUI (v0.12.0 confirmed)
    // removed 'flux' from the single CLIPLoader's type enum — FLUX v1 text
    // encoding lives in DualCLIPLoader (clip_name1 = T5-XXL, clip_name2 =
    // CLIP-L, type 'flux'), which has shipped with every FLUX-era ComfyUI.
    // Emit it whenever the instance has the node; the single-CLIPLoader path
    // stays as the fallback for pre-FLUX-era instances (whose CLIPLoader enum
    // still contains 'flux'). Same pattern as the HunyuanVideo DualCLIPLoader
    // below.
    const useDualFluxClip = type === 'flux' && nodes.loaders.includes('DualCLIPLoader')

    let clip = ''
    let fluxPair: { t5: string; clipL: string } | null = null
    if (useDualFluxClip) {
      try {
        fluxPair = await findFluxCLIPPair()
      } catch (clipErr) {
        throw new WorkflowUnavailableError(
          clipErr instanceof Error ? clipErr.message : 'Required text encoder not found in ComfyUI.',
          strategy,
        )
      }
    } else {
      try {
        clip = await findMatchingCLIP(type, params.model)
      } catch (clipErr) {
        throw new WorkflowUnavailableError(
          clipErr instanceof Error ? clipErr.message : 'Required text encoder not found in ComfyUI.',
          strategy,
        )
      }
    }

    // VAE is only loaded for strategies with a separate VAELoader — LTX bakes it
    // into the pipeline, so a missing VAE there is fine. Validate (same
    // no-silent-fallback rule) only when it will actually be used.
    const needsVAELoader = strategy !== 'unet_ltx'
    let vae = ''
    if (needsVAELoader) {
      try {
        vae = await findMatchingVAE(type)
      } catch (vaeErr) {
        throw new WorkflowUnavailableError(
          vaeErr instanceof Error ? vaeErr.message : 'Required VAE not found in ComfyUI.',
          strategy,
        )
      }
    }

    workflow[unetId] = {
      class_type: 'UNETLoader',
      inputs: { unet_name: params.model, weight_dtype: 'default' },
    }
    workflow[clipId] = useDualFluxClip && fluxPair
      ? {
          class_type: 'DualCLIPLoader',
          inputs: { clip_name1: fluxPair.t5, clip_name2: fluxPair.clipL, type: 'flux' },
        }
      : {
          class_type: 'CLIPLoader',
          inputs: { clip_name: clip, type: clipType, device: 'default' },
        }

    let vaeId: string
    if (needsVAELoader) {
      vaeId = String(n++)
      workflow[vaeId] = {
        class_type: 'VAELoader',
        inputs: { vae_name: vae },
      }
    } else {
      vaeId = unetId // fallback reference (won't be used for LTX)
    }

    modelNodeId = unetId
    clipSourceId = clipId
    clipOutputSlot = 0
    vaeSourceId = vaeId
    vaeOutputSlot = 0
    samplerModelId = unetId

  } else {
    // AnimateDiff: checkpoint + motion model
    const ckptId = String(n++)
    const motionLoadId = String(n++)
    const motionApplyId = String(n++)
    const evolvedId = String(n++)

    workflow[ckptId] = {
      class_type: 'CheckpointLoaderSimple',
      inputs: { ckpt_name: params.model },
    }
    workflow[motionLoadId] = {
      class_type: 'ADE_LoadAnimateDiffModel',
      inputs: { model_name: models.motionModels[0] },
    }
    workflow[motionApplyId] = {
      class_type: 'ADE_ApplyAnimateDiffModelSimple',
      inputs: { motion_model: [motionLoadId, 0] },
    }
    workflow[evolvedId] = {
      class_type: 'ADE_UseEvolvedSampling',
      inputs: {
        model: [ckptId, 0],
        m_models: [motionApplyId, 0],
        beta_schedule: 'autoselect',
      },
    }

    modelNodeId = ckptId
    clipSourceId = ckptId
    clipOutputSlot = 1
    vaeSourceId = ckptId
    vaeOutputSlot = 2
    samplerModelId = evolvedId
  }

  // ─── Phase 1b: Optional LoRA chain + VAE + Skip-CLIP injection (F2 + F3) ───
  //
  // LoRA chain (cinemazverev GH#4; multi-LoRA konata 2026-06-09): each
  // LoraLoader takes (model, clip) and outputs new (model, clip) — chaining
  // N loaders applies the LoRAs in order, exactly like stacking them in the
  // ComfyUI graph editor. We rewire both refs after every link so the rest
  // of the pipeline sees the fully-stacked versions. Names are resolved
  // against ComfyUI's real LoraLoader enum (fuzzy: extension/case optional)
  // and a miss throws an actionable error instead of ComfyUI's opaque
  // "Value not in list".
  //
  // VAE override (vanja-san GH#4): VAELoader replaces vaeSourceId. The
  // checkpoint's bundled VAE stays unused.
  //
  // Skip CLIP (vanja-san GH#4): CLIPSetLastLayer takes a negative
  // `stop_at_clip_layer` index — passing -clipSkip mirrors A1111 /
  // ComfyUI conventions.
  //
  // All three are skipped (no extra nodes) when the corresponding
  // param is unset, so workflows without F2/F3 enabled stay byte-
  // identical to the previous behaviour.
  const loraNames = normalizeLoraList(params.lora)
  if (loraNames.length > 0) {
    const installed: string[] =
      (allNodes?.LoraLoader?.input?.required?.lora_name?.[0] as string[] | undefined) ?? []
    const resolved = resolveLoraNames(loraNames, installed)
    const strengths = normalizeLoraStrengths(params.loraStrength, resolved.length)
    resolved.forEach((loraName, i) => {
      const loraId = String(n++)
      workflow[loraId] = {
        class_type: 'LoraLoader',
        inputs: {
          lora_name: loraName,
          strength_model: strengths[i],
          strength_clip: strengths[i],
          model: [samplerModelId, 0],
          clip: [clipSourceId, clipOutputSlot],
        },
      }
      samplerModelId = loraId
      clipSourceId = loraId
      clipOutputSlot = 1
    })
  }

  if (params.vae && params.vae !== 'auto') {
    const vaeId = String(n++)
    workflow[vaeId] = {
      class_type: 'VAELoader',
      inputs: { vae_name: params.vae },
    }
    vaeSourceId = vaeId
    vaeOutputSlot = 0
  }

  if (params.clipSkip && params.clipSkip > 0) {
    const skipId = String(n++)
    workflow[skipId] = {
      class_type: 'CLIPSetLastLayer',
      inputs: {
        stop_at_clip_layer: -Math.abs(params.clipSkip),
        clip: [clipSourceId, clipOutputSlot],
      },
    }
    clipSourceId = skipId
    clipOutputSlot = 0
  }

  // ─── Phase 2: Text Encoding ───

  const posId = String(n++)
  const negId = String(n++)

  workflow[posId] = {
    class_type: 'CLIPTextEncode',
    inputs: { text: params.prompt, clip: [clipSourceId, clipOutputSlot] },
  }

  if (strategy === 'unet_ernie_image') {
    // ERNIE-Image uses ConditioningZeroOut for negative (NOT CLIPTextEncode)
    workflow[negId] = {
      class_type: 'ConditioningZeroOut',
      inputs: { conditioning: [posId, 0] },
    }
  } else {
    workflow[negId] = {
      class_type: 'CLIPTextEncode',
      inputs: {
        text: params.negativePrompt || '',
        clip: [clipSourceId, clipOutputSlot],
      },
    }
  }

  // ─── Phase 3: Latent Initialization ───
  // I2I mode: LoadImage → VAEEncode instead of empty latent
  const isI2I = !isVideo && params.inputImage && (params.denoise ?? 1.0) < 1.0

  const latentId = String(n++)

  if (strategy === 'unet_video') {
    // Wan/Hunyuan video latent
    const latentNode = nodes.latentInit.includes('EmptyHunyuanLatentVideo')
      ? 'EmptyHunyuanLatentVideo'
      : 'EmptyLatentImage'

    workflow[latentId] = {
      class_type: latentNode,
      inputs: latentNode === 'EmptyHunyuanLatentVideo'
        ? { width: params.width, height: params.height, length: videoParams.frames, batch_size: 1 }
        : { width: params.width, height: params.height, batch_size: videoParams.frames },
    }
  } else if (strategy === 'animatediff') {
    // AnimateDiff: batch_size = frames
    workflow[latentId] = {
      class_type: 'EmptyLatentImage',
      inputs: { width: params.width, height: params.height, batch_size: videoParams.frames },
    }
  } else if (strategy === 'unet_mochi') {
    // Mochi video latent
    const latentNode = nodes.latentInit.includes('EmptyMochiLatentVideo')
      ? 'EmptyMochiLatentVideo'
      : 'EmptyHunyuanLatentVideo'
    workflow[latentId] = {
      class_type: latentNode,
      inputs: { width: params.width, height: params.height, length: videoParams.frames, batch_size: 1 },
    }
  } else if (strategy === 'unet_cosmos') {
    // Cosmos video latent
    const latentNode = nodes.latentInit.includes('EmptyCosmosLatentVideo')
      ? 'EmptyCosmosLatentVideo'
      : 'EmptyHunyuanLatentVideo'
    workflow[latentId] = {
      class_type: latentNode,
      inputs: { width: params.width, height: params.height, length: videoParams.frames, batch_size: 1 },
    }
  } else if (strategy === 'unet_ltx') {
    // LTX Video latent — uses length instead of batch_size
    workflow[latentId] = {
      class_type: 'EmptyLTXVLatentVideo',
      inputs: { width: params.width, height: params.height, length: videoParams.frames, batch_size: 1 },
    }
  } else if (strategy === 'unet_flux2' || strategy === 'unet_ernie_image') {
    // FLUX 2 / ERNIE-Image use Flux2 latent node
    const latentNode = nodes.latentInit.includes('EmptyFlux2LatentImage')
      ? 'EmptyFlux2LatentImage'
      : 'EmptySD3LatentImage'
    workflow[latentId] = {
      class_type: latentNode,
      inputs: { width: params.width, height: params.height, batch_size: params.batchSize },
    }
  } else if (strategy === 'unet_zimage') {
    // Z-Image uses SD3 latent (same architecture family)
    const latentNode = nodes.latentInit.includes('EmptySD3LatentImage')
      ? 'EmptySD3LatentImage'
      : 'EmptyLatentImage'
    workflow[latentId] = {
      class_type: latentNode,
      inputs: { width: params.width, height: params.height, batch_size: params.batchSize },
    }
  } else if (strategy === 'unet_flux') {
    // FLUX 1 uses SD3 latent
    const latentNode = nodes.latentInit.includes('EmptySD3LatentImage')
      ? 'EmptySD3LatentImage'
      : 'EmptyLatentImage'
    workflow[latentId] = {
      class_type: latentNode,
      inputs: { width: params.width, height: params.height, batch_size: params.batchSize },
    }
  } else {
    // Checkpoint (SDXL/SD1.5)
    workflow[latentId] = {
      class_type: 'EmptyLatentImage',
      inputs: { width: params.width, height: params.height, batch_size: params.batchSize },
    }
  }

  // I2I override: replace empty latent with LoadImage → VAEEncode
  let latentSourceId = latentId
  if (isI2I) {
    const loadImageId = String(n++)
    const vaeEncodeId = String(n++)
    workflow[loadImageId] = {
      class_type: 'LoadImage',
      inputs: { image: params.inputImage },
    }
    workflow[vaeEncodeId] = {
      class_type: 'VAEEncode',
      inputs: { pixels: [loadImageId, 0], vae: [vaeSourceId, vaeOutputSlot] },
    }
    latentSourceId = vaeEncodeId
    // Remove the empty latent node since we're using the encoded image
    delete workflow[latentId]
  }

  // ─── Phase 4: Sampling ───

  const samplerId = String(n++)

  workflow[samplerId] = {
    class_type: 'KSampler',
    inputs: {
      model: [samplerModelId, 0],
      positive: [posId, 0],
      negative: [negId, 0],
      latent_image: [latentSourceId, 0],
      seed,
      steps: params.steps,
      cfg: params.cfgScale,
      sampler_name: params.sampler,
      scheduler: params.scheduler,
      denoise: isI2I ? (params.denoise ?? 0.7) : 1.0,
    },
  }

  // ─── Phase 5: Decode ───

  const decodeId = String(n++)

  workflow[decodeId] = {
    class_type: 'VAEDecode',
    inputs: {
      samples: [samplerId, 0],
      vae: [vaeSourceId, vaeOutputSlot],
    },
  }

  // ─── Phase 6: Output ───

  const saveId = String(n++)

  if (isVideo) {
    // Video output: prefer VHS > SaveAnimatedWEBP > SaveImage
    const vidPrefix = promptFilenamePrefix(params.prompt, true)
    if (nodes.videoSavers.includes('VHS_VideoCombine')) {
      workflow[saveId] = {
        class_type: 'VHS_VideoCombine',
        inputs: {
          images: [decodeId, 0],
          frame_rate: videoParams.fps,
          loop_count: 0,
          filename_prefix: vidPrefix,
          format: 'video/h264-mp4',
          pingpong: false,
          save_output: true,
        },
      }
    } else if (nodes.videoSavers.includes('SaveAnimatedWEBP')) {
      workflow[saveId] = {
        class_type: 'SaveAnimatedWEBP',
        inputs: {
          images: [decodeId, 0],
          filename_prefix: vidPrefix,
          fps: videoParams.fps,
          lossless: false,
          quality: 90,
          method: 'default',
        },
      }
    } else {
      workflow[saveId] = {
        class_type: 'SaveImage',
        inputs: {
          images: [decodeId, 0],
          filename_prefix: vidPrefix,
        },
      }
    }
  } else {
    workflow[saveId] = {
      class_type: 'SaveImage',
      inputs: {
        images: [decodeId, 0],
        filename_prefix: promptFilenamePrefix(params.prompt, false),
      },
    }
  }

  log.info(`[dynamic-workflow] Built ${Object.keys(workflow).length} nodes`, {
    nodes: Object.entries(workflow).map(([id, node]) => `${id}:${node.class_type}`).join(' → ')
  })

  return workflow
}

// ─── Wrapper Workflow Builders ───

function addVideoOutput(workflow: Record<string, any>, n: number, decodeId: string, fps: number, nodes: CategorizedNodes, prompt?: string): number {
  const saveId = String(n++)
  const prefix = promptFilenamePrefix(prompt, true)
  if (nodes.videoSavers.includes('VHS_VideoCombine')) {
    workflow[saveId] = {
      class_type: 'VHS_VideoCombine',
      inputs: { images: [decodeId, 0], frame_rate: fps, loop_count: 0, filename_prefix: prefix, format: 'video/h264-mp4', pingpong: false, save_output: true },
    }
  } else if (nodes.videoSavers.includes('SaveAnimatedWEBP')) {
    workflow[saveId] = {
      class_type: 'SaveAnimatedWEBP',
      inputs: { images: [decodeId, 0], filename_prefix: prefix, fps, lossless: false, quality: 90, method: 'default' },
    }
  } else {
    workflow[saveId] = {
      class_type: 'SaveImage',
      inputs: { images: [decodeId, 0], filename_prefix: prefix },
    }
  }
  return n
}

function buildCogVideoWorkflow(params: VideoParams, seed: number, nodes: CategorizedNodes): Record<string, any> {
  const workflow: Record<string, any> = {}
  let n = 1

  const modelId = String(n++)
  const clipId = String(n++)
  const posId = String(n++)
  const negId = String(n++)
  const latentId = String(n++)
  const samplerId = String(n++)
  const decodeId = String(n++)

  workflow[modelId] = { class_type: 'CogVideoXModelLoader', inputs: { model: params.model } }
  workflow[clipId] = { class_type: 'CogVideoXCLIPLoader', inputs: { clip_name: 't5xxl_fp16.safetensors' } }
  workflow[posId] = { class_type: 'CogVideoXTextEncode', inputs: { text: params.prompt, clip: [clipId, 0] } }
  workflow[negId] = { class_type: 'CogVideoXTextEncode', inputs: { text: params.negativePrompt || '', clip: [clipId, 0] } }
  workflow[latentId] = { class_type: 'CogVideoXEmptyLatents', inputs: { width: params.width, height: params.height, frames: params.frames, batch_size: 1 } }
  workflow[samplerId] = {
    class_type: 'CogVideoXSampler',
    inputs: { model: [modelId, 0], positive: [posId, 0], negative: [negId, 0], latents: [latentId, 0], seed, steps: params.steps, cfg: params.cfgScale },
  }
  workflow[decodeId] = { class_type: 'CogVideoXVAEDecode', inputs: { samples: [samplerId, 0], vae: [modelId, 1] } }

  addVideoOutput(workflow, n, decodeId, params.fps, nodes, params.prompt)
  return workflow
}

function buildSVDWorkflow(params: VideoParams, seed: number, nodes: CategorizedNodes): Record<string, any> {
  const workflow: Record<string, any> = {}
  let n = 1

  const loaderId = String(n++)
  const imageId = String(n++)
  const scaleId = String(n++)
  const condId = String(n++)
  const guidanceId = String(n++)
  const samplerId = String(n++)
  const decodeId = String(n++)

  workflow[loaderId] = { class_type: 'ImageOnlyCheckpointLoader', inputs: { ckpt_name: params.model } }
  workflow[imageId] = { class_type: 'LoadImage', inputs: { image: params.inputImage || 'input_image.png' } }
  // Aspect-fill the source into the SVD generation resolution (David 2026-06-11:
  // a portrait/square still fed straight in came back squished and no longer
  // matched the input). crop:'center' scales to cover width×height then
  // centre-crops — so the conditioning sees the source at the right aspect with
  // no distortion, instead of SVD stretching it internally.
  workflow[scaleId] = {
    class_type: 'ImageScale',
    inputs: { image: [imageId, 0], upscale_method: 'lanczos', width: params.width, height: params.height, crop: 'center' },
  }
  workflow[condId] = {
    class_type: 'SVD_img2vid_Conditioning',
    inputs: {
      clip_vision: [loaderId, 1], init_image: [scaleId, 0], vae: [loaderId, 2],
      augmentation_level: 0.0, width: params.width, height: params.height,
      video_frames: params.frames,
      // Lower motion = stays closer to the source (127 = SVD's high-drift default).
      motion_bucket_id: params.motionBucketId ?? 90,
      fps: params.fps,
    },
  }
  workflow[guidanceId] = { class_type: 'VideoLinearCFGGuidance', inputs: { model: [loaderId, 0], min_cfg: 1.0 } }
  workflow[samplerId] = {
    class_type: 'KSampler',
    inputs: { model: [guidanceId, 0], positive: [condId, 0], negative: [condId, 1], latent_image: [condId, 2], seed, steps: params.steps, cfg: params.cfgScale, sampler_name: params.sampler, scheduler: params.scheduler, denoise: 1.0 },
  }
  workflow[decodeId] = { class_type: 'VAEDecode', inputs: { samples: [samplerId, 0], vae: [loaderId, 2] } }

  addVideoOutput(workflow, n, decodeId, params.fps, nodes, params.prompt)
  return workflow
}

/**
 * Snap a frame count to Wan 2.2's length grid. The Wan 2.2 VAE has a temporal
 * stride of 4, so `Wan22ImageToVideoLatent.length` must be 4k+1 (…45, 49, 53…).
 * An off-grid length makes ComfyUI error or silently drop the tail frame.
 * Exported + pure for the unit tests and the vram-handoff duration math.
 */
export function snapWanLength(frames: number): number {
  const f = Number.isFinite(frames) ? Math.round(frames) : 49
  const k = Math.max(1, Math.round((f - 1) / 4))
  return k * 4 + 1
}

/**
 * Wan 2.2 TI2V-5B — one model, both modes. `Wan22ImageToVideoLatent` takes an
 * OPTIONAL `start_image`: present → image-to-video (the clip opens on the source
 * still), absent → text-to-video. Uses the Wan 2.2 VAE (NOT the 2.1 VAE — the 2.2
 * VAE has 16× spatial / 4× temporal compression, a different latent shape) and the
 * shared UMT5-XXL text encoder. `ModelSamplingSD3` applies Wan's sampling shift.
 *
 * I2V faithfulness (David 2026-06-11): an `ImageScale(crop:center)` aspect-fills
 * the source into the generation size, so the first frame matches the still
 * instead of being squished — the same fix proven on the SVD path.
 */
function buildWan22Workflow(params: VideoParams, seed: number, nodes: CategorizedNodes): Record<string, any> {
  const workflow: Record<string, any> = {}
  let n = 1

  // Wan 2.2 dims snap to 32 (VAE spatial grid); length to 4k+1 (temporal stride 4).
  const snap32 = (v: number | undefined, def: number) => Math.max(64, Math.round(((v && v > 0) ? v : def) / 32) * 32)
  const width = snap32(params.width, 1024)
  const height = snap32(params.height, 576)
  const length = snapWanLength(params.frames || 49)

  const unetId = String(n++)
  const clipId = String(n++)
  const vaeId = String(n++)
  const posId = String(n++)
  const negId = String(n++)

  workflow[unetId] = { class_type: 'UNETLoader', inputs: { unet_name: params.model, weight_dtype: 'default' } }
  workflow[clipId] = { class_type: 'CLIPLoader', inputs: { clip_name: 'umt5_xxl_fp8_e4m3fn_scaled.safetensors', type: 'wan', device: 'default' } }
  workflow[vaeId] = { class_type: 'VAELoader', inputs: { vae_name: 'wan2.2_vae.safetensors' } }
  workflow[posId] = { class_type: 'CLIPTextEncode', inputs: { text: params.prompt, clip: [clipId, 0] } }
  workflow[negId] = { class_type: 'CLIPTextEncode', inputs: { text: params.negativePrompt || '', clip: [clipId, 0] } }

  // Wan's recommended sampling shift. ModelSamplingSD3 is a core node (ships since
  // SD3), so the sampler reads from it to match the official 5B workflow's motion.
  const shiftId = String(n++)
  workflow[shiftId] = { class_type: 'ModelSamplingSD3', inputs: { model: [unetId, 0], shift: 8.0 } }

  // Unified latent: a start_image is attached ONLY for an I2V request.
  const latentInputs: Record<string, any> = { vae: [vaeId, 0], width, height, length, batch_size: 1 }
  if (params.inputImage) {
    const imageId = String(n++)
    const scaleId = String(n++)
    workflow[imageId] = { class_type: 'LoadImage', inputs: { image: params.inputImage } }
    workflow[scaleId] = { class_type: 'ImageScale', inputs: { image: [imageId, 0], upscale_method: 'lanczos', width, height, crop: 'center' } }
    latentInputs.start_image = [scaleId, 0]
  }
  const latentId = String(n++)
  workflow[latentId] = { class_type: 'Wan22ImageToVideoLatent', inputs: latentInputs }

  const samplerId = String(n++)
  workflow[samplerId] = {
    class_type: 'KSampler',
    inputs: {
      model: [shiftId, 0], positive: [posId, 0], negative: [negId, 0], latent_image: [latentId, 0],
      seed, steps: params.steps, cfg: params.cfgScale, sampler_name: params.sampler, scheduler: params.scheduler, denoise: 1.0,
    },
  }
  const decodeId = String(n++)
  workflow[decodeId] = { class_type: 'VAEDecode', inputs: { samples: [samplerId, 0], vae: [vaeId, 0] } }

  addVideoOutput(workflow, n, decodeId, params.fps, nodes, params.prompt)
  return workflow
}

function buildFramePackWorkflow(params: VideoParams, seed: number, nodes: CategorizedNodes): Record<string, any> {
  const workflow: Record<string, any> = {}
  let n = 1

  const modelId = String(n++)
  const clipId = String(n++)
  const clipVisionId = String(n++)
  const vaeId = String(n++)
  const imageId = String(n++)
  const posId = String(n++)
  const samplerId = String(n++)
  const decodeId = String(n++)

  // VRAM-safe load (David 2026-06-11, live OOM on his RTX 3060 12GB):
  // `quantization:'disabled' + base_precision:'bf16' + load_device:'main_device'`
  // UPCAST the fp8 13B weights to bf16 (~26 GB) and put the whole transformer on
  // the GPU at once → torch.OutOfMemoryError in LoadFramePackModel before a single
  // step ran. The file is already fp8_e4m3fn, so keep it quantized and load to the
  // OFFLOAD (CPU) device — FramePack's section sampler streams it onto the GPU a
  // window at a time (gpu_memory_preservation governs the headroom). This is the
  // documented low-VRAM combo and is what makes FramePack actually run on 12 GB
  // (and down to ~6 GB) instead of OOMing on every consumer card.
  workflow[modelId] = { class_type: 'LoadFramePackModel', inputs: { model: params.model, base_precision: 'bf16', quantization: 'fp8_e4m3fn', load_device: 'offload_device' } }
  // DualCLIPLoader with type "hunyuan_video" — CLIPLoader type "wan" creates Llama2 with 128256 vocab
  // but llava_llama3 has 128320 tokens, causing state_dict size mismatch. DualCLIPLoader handles both correctly.
  workflow[clipId] = { class_type: 'DualCLIPLoader', inputs: { clip_name1: 'clip_l.safetensors', clip_name2: 'llava_llama3_fp8_scaled.safetensors', type: 'hunyuan_video' } }
  workflow[clipVisionId] = { class_type: 'CLIPVisionLoader', inputs: { clip_name: 'sigclip_vision_patch14_384.safetensors' } }
  workflow[vaeId] = { class_type: 'VAELoader', inputs: { vae_name: 'hunyuanvideo15_vae_fp16.safetensors' } }
  workflow[imageId] = { class_type: 'LoadImage', inputs: { image: params.inputImage || 'input_image.png' } }
  // Scale the source to the resolved generation size before encoding (David
  // 2026-06-11). FramePack otherwise samples at the full source resolution
  // (a 1024×1024 still → very slow + heavy on a 12 GB card). resolveI2VResolution
  // already picked an aspect-preserving size capped at 768 / snapped to 16;
  // crop:'center' fills it without distortion. Feeds BOTH the CLIP-vision and
  // VAE encoders so the embeds and latent agree on the framing.
  const fpScaleId = String(n++)
  workflow[fpScaleId] = {
    class_type: 'ImageScale',
    inputs: { image: [imageId, 0], upscale_method: 'lanczos', width: params.width || 640, height: params.height || 640, crop: 'center' },
  }
  // Encode image for CLIP vision embeddings (FramePackSampler image_embeds input)
  const clipVisionEncodeId = String(n++)
  workflow[clipVisionEncodeId] = { class_type: 'CLIPVisionEncode', inputs: { crop: 'center', clip_vision: [clipVisionId, 0], image: [fpScaleId, 0] } }
  // Encode image to latent (FramePackSampler needs LATENT, not IMAGE)
  const vaeEncodeId = String(n++)
  workflow[vaeEncodeId] = { class_type: 'VAEEncode', inputs: { pixels: [fpScaleId, 0], vae: [vaeId, 0] } }
  workflow[posId] = { class_type: 'CLIPTextEncode', inputs: { text: params.prompt, clip: [clipId, 0] } }
  const negId = String(n++)
  workflow[negId] = { class_type: 'CLIPTextEncode', inputs: { text: '', clip: [clipId, 0] } }
  workflow[samplerId] = {
    class_type: 'FramePackSampler',
    inputs: {
      model: [modelId, 0], positive: [posId, 0], negative: [negId, 0],
      start_latent: [vaeEncodeId, 0], image_embeds: [clipVisionEncodeId, 0],
      steps: params.steps, cfg: params.cfgScale || 1.0,
      guidance_scale: 10.0, shift: 3.0, seed, latent_window_size: 9,
      // VideoParams carries `frames` (not `numFrames`) — reading the wrong field
      // pinned every FramePack clip to the 49-frame default and silently ignored
      // the caller's requested length. FramePack is duration-driven, so the clip
      // length = frames / fps seconds.
      total_second_length: (params.frames || 49) / (params.fps || 16),
      gpu_memory_preservation: 6.0, sampler: 'unipc_bh2',
      use_teacache: true, teacache_rel_l1_thresh: 0.15,
    },
  }
  workflow[decodeId] = { class_type: 'VAEDecode', inputs: { samples: [samplerId, 0], vae: [vaeId, 0] } }

  addVideoOutput(workflow, n, decodeId, params.fps, nodes, params.prompt)
  return workflow
}

function buildPyramidFlowWorkflow(params: VideoParams, seed: number, nodes: CategorizedNodes): Record<string, any> {
  const workflow: Record<string, any> = {}
  let n = 1

  const modelId = String(n++)
  const vaeId = String(n++)
  const posId = String(n++)
  const samplerId = String(n++)
  const decodeId = String(n++)

  workflow[modelId] = { class_type: 'PyramidFlowModelLoader', inputs: { model: params.model } }
  workflow[vaeId] = { class_type: 'PyramidFlowVAELoader', inputs: { vae: 'pyramid_flow_vae_bf16.safetensors' } }
  workflow[posId] = { class_type: 'PyramidFlowTextEncode', inputs: { text: params.prompt } }
  workflow[samplerId] = {
    class_type: 'PyramidFlowSampler',
    inputs: { model: [modelId, 0], vae: [vaeId, 0], text: [posId, 0], seed, steps: params.steps, cfg: params.cfgScale, width: params.width, height: params.height, frames: params.frames },
  }
  workflow[decodeId] = { class_type: 'PyramidFlowDecode', inputs: { samples: [samplerId, 0] } }

  addVideoOutput(workflow, n, decodeId, params.fps, nodes, params.prompt)
  return workflow
}

function buildAllegroWorkflow(params: VideoParams, seed: number, nodes: CategorizedNodes): Record<string, any> {
  const workflow: Record<string, any> = {}
  let n = 1

  const modelId = String(n++)
  const posId = String(n++)
  const samplerId = String(n++)
  const decodeId = String(n++)

  workflow[modelId] = { class_type: 'AllegroModelLoader', inputs: { model: params.model } }
  workflow[posId] = { class_type: 'AllegroTextEncode', inputs: { text: params.prompt } }
  workflow[samplerId] = {
    class_type: 'AllegroSampler',
    inputs: { model: [modelId, 0], text: [posId, 0], seed, steps: params.steps, cfg: params.cfgScale, width: params.width, height: params.height, frames: params.frames },
  }
  workflow[decodeId] = { class_type: 'AllegroDecoder', inputs: { samples: [samplerId, 0] } }

  addVideoOutput(workflow, n, decodeId, params.fps, nodes, params.prompt)
  return workflow
}
