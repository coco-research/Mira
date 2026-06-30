/**
 * Local vs. cloud classification for the Architect picker.
 *
 * LU's promise is "local + uncensored + private". Letting users wire a
 * third-party cloud (Anthropic / OpenAI / OpenRouter / …) as the
 * Architect quietly breaks that — every planning step leaves the
 * machine. The UI now defaults to LOCAL-only and shows a deliberate
 * opt-in if the user wants to override, with a planned "LU Cloud
 * Premium" tier as the privacy-preserving alternative (TEE-attested
 * open-weights hosted by us — coming with Cloud Studio).
 */

import type { AIModel } from '../../types/models'
import { useProviderStore } from '../../stores/providerStore'

/**
 * True when the model runs on the user's own machine (Ollama, LM Studio,
 * vLLM, llama.cpp, …). False for any cloud endpoint (Anthropic,
 * OpenRouter, Groq, OpenAI direct, …).
 *
 * For OpenAI-compatible providers the answer depends on the configured
 * `baseUrl` — `localhost:1234` is LM Studio, `api.openai.com` is the
 * real OpenAI. The provider store carries the `isLocal` flag for that
 * configured endpoint; we look it up by provider id.
 */
export function isLocalModel(model: AIModel): boolean {
  if (!model) return false
  if (model.provider === 'ollama') return true
  if (model.provider === 'anthropic') return false
  if (model.provider === 'openai') {
    const cfg = useProviderStore.getState().providers['openai']
    return cfg?.isLocal === true
  }
  return false
}

/** Same check but operating on a prefixed model name (`anthropic::xyz`). */
export function isLocalModelByName(name: string): boolean {
  if (!name) return false
  const [providerId] = name.split('::')
  if (providerId === 'ollama' || !name.includes('::')) return true
  if (providerId === 'anthropic') return false
  if (providerId === 'openai') {
    const cfg = useProviderStore.getState().providers['openai']
    return cfg?.isLocal === true
  }
  return false
}

/**
 * Splits a model list into [local, cloud]. Used by the Architect
 * picker to render two groups + the local-first warning text.
 */
export function partitionByLocality(models: AIModel[]): {
  local: AIModel[]
  cloud: AIModel[]
} {
  const local: AIModel[] = []
  const cloud: AIModel[] = []
  for (const m of models) {
    if (isLocalModel(m)) local.push(m)
    else cloud.push(m)
  }
  return { local, cloud }
}
