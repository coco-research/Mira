/**
 * Bug C (aldrich): FLUX "CLIPLoader: Value not in list".
 *
 * Root cause was buildDynamicWorkflow's silent catch fallback
 * (`clip = models.clips[0] || ''`): when no matching text encoder was found it
 * emitted an empty/wrong clip_name, which ComfyUI rejects with that cryptic
 * error. The fix propagates findMatchingCLIP's actionable "download <encoder>"
 * message as a WorkflowUnavailableError instead.
 *
 * Run: npx vitest run src/api/__tests__/dynamic-workflow-clip-missing.test.ts
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

// Mock the live-fetch boundary; keep the real pure helpers (classifyModel,
// categorizeNodes, detectAvailableModels, determineStrategy).
vi.mock('../comfyui-nodes', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../comfyui-nodes')>()
  return { ...actual, getAllNodeInfo: vi.fn() }
})
vi.mock('../comfyui', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../comfyui')>()
  return { ...actual, findMatchingCLIP: vi.fn(), findMatchingVAE: vi.fn(), findFluxCLIPPair: vi.fn() }
})

import { buildDynamicWorkflow, WorkflowUnavailableError } from '../dynamic-workflow'
import { getAllNodeInfo } from '../comfyui-nodes'
import { findMatchingCLIP, findMatchingVAE, findFluxCLIPPair } from '../comfyui'

// Minimal /object_info that categorizes to a FLUX unet strategy.
// Deliberately NO DualCLIPLoader → exercises the legacy single-CLIPLoader
// fallback (pre-FLUX-era ComfyUI whose CLIPLoader enum still has 'flux').
const FLUX_NODES = {
  UNETLoader: { input: { required: { unet_name: [[]] } } },
  CLIPLoader: { input: { required: { clip_name: [[]] } } },
  VAELoader: { input: { required: { vae_name: [[]] } } },
  KSampler: { input: { required: {} } },
  EmptySD3LatentImage: { input: { required: {} } },
  CLIPTextEncode: { input: { required: {} } },
  VAEDecode: { input: { required: {} } },
  SaveImage: { input: { required: {} } },
}

// Modern instance (ComfyUI ≥ v0.12: single CLIPLoader has NO 'flux' type —
// FLUX v1 must go through DualCLIPLoader). C2 repro environment.
const FLUX_NODES_DUAL = {
  ...FLUX_NODES,
  DualCLIPLoader: { input: { required: { clip_name1: [[]], clip_name2: [[]], type: [[]] } } },
}

const fluxParams = {
  model: 'flux1-dev-fp8.safetensors',
  prompt: 'a cat', negativePrompt: '',
  width: 1024, height: 1024, steps: 20, cfg: 1, seed: 1,
} as never

describe('buildDynamicWorkflow — Bug C: missing FLUX text encoder', () => {
  beforeEach(() => {
    vi.mocked(getAllNodeInfo).mockResolvedValue(FLUX_NODES as never)
    vi.mocked(findMatchingVAE).mockResolvedValue('ae.safetensors')
  })

  it('throws an actionable WorkflowUnavailableError instead of emitting clip_name:""', async () => {
    vi.mocked(findMatchingCLIP).mockRejectedValue(
      new Error('No FLUX text encoder (T5) found. Download "t5xxl_fp8_e4m3fn.safetensors" from the Model Manager.'),
    )
    await expect(buildDynamicWorkflow(fluxParams)).rejects.toBeInstanceOf(WorkflowUnavailableError)
    await expect(buildDynamicWorkflow(fluxParams)).rejects.toThrow(/download/i)
  })

  it('uses the resolved encoder (never an empty clip_name) when one is found', async () => {
    vi.mocked(findMatchingCLIP).mockResolvedValue('t5xxl_fp8_e4m3fn.safetensors')
    const wf = await buildDynamicWorkflow(fluxParams)
    const clipLoader = Object.values(wf).find((n) => (n as { class_type?: string }).class_type === 'CLIPLoader') as
      | { inputs: { clip_name: string } }
      | undefined
    expect(clipLoader?.inputs.clip_name).toBe('t5xxl_fp8_e4m3fn.safetensors')
    expect(clipLoader?.inputs.clip_name).not.toBe('')
  })
})

describe('buildDynamicWorkflow — C2: FLUX v1 on modern ComfyUI uses DualCLIPLoader', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(getAllNodeInfo).mockResolvedValue(FLUX_NODES_DUAL as never)
    vi.mocked(findMatchingVAE).mockResolvedValue('ae.safetensors')
  })

  it('emits DualCLIPLoader (t5 + clip_l, type flux) instead of single CLIPLoader', async () => {
    vi.mocked(findFluxCLIPPair).mockResolvedValue({
      t5: 't5xxl_fp8_e4m3fn.safetensors',
      clipL: 'clip_l.safetensors',
    })
    const wf = await buildDynamicWorkflow(fluxParams)
    const nodes = Object.values(wf) as { class_type: string; inputs: Record<string, unknown> }[]
    const dual = nodes.find((n) => n.class_type === 'DualCLIPLoader')
    expect(dual?.inputs).toEqual({
      clip_name1: 't5xxl_fp8_e4m3fn.safetensors',
      clip_name2: 'clip_l.safetensors',
      type: 'flux',
    })
    // No single CLIPLoader with the (now invalid) type 'flux' may remain.
    const singleFlux = nodes.find((n) => n.class_type === 'CLIPLoader' && n.inputs.type === 'flux')
    expect(singleFlux).toBeUndefined()
    expect(vi.mocked(findMatchingCLIP)).not.toHaveBeenCalled()
  })

  it('propagates the actionable per-encoder error (e.g. missing CLIP-L)', async () => {
    vi.mocked(findFluxCLIPPair).mockRejectedValue(
      new Error('No FLUX CLIP-L text encoder found. Download "clip_l.safetensors" from the Model Manager.'),
    )
    await expect(buildDynamicWorkflow(fluxParams)).rejects.toBeInstanceOf(WorkflowUnavailableError)
    await expect(buildDynamicWorkflow(fluxParams)).rejects.toThrow(/clip_l\.safetensors/)
  })

  it('keeps the single CLIPLoader for flux2 (its type IS valid there)', async () => {
    vi.mocked(findMatchingCLIP).mockResolvedValue('qwen_3_4b_fp4_flux2.safetensors')
    const wf = await buildDynamicWorkflow({
      ...(fluxParams as Record<string, unknown>),
      model: 'flux-2-klein-base-4b.safetensors',
    } as never)
    const nodes = Object.values(wf) as { class_type: string; inputs: Record<string, unknown> }[]
    expect(nodes.find((n) => n.class_type === 'DualCLIPLoader')).toBeUndefined()
    const single = nodes.find((n) => n.class_type === 'CLIPLoader')
    expect(single?.inputs.type).toBe('flux2')
    expect(vi.mocked(findFluxCLIPPair)).not.toHaveBeenCalled()
  })
})
