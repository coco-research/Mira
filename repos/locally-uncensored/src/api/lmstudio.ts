// LM Studio per-model load/unload, mirroring the Ollama API surface in
// api/ollama.ts. LM Studio's HTTP server has no load/unload endpoints, so
// the bridge wraps the `lms` CLI for state changes and reads the loaded
// list from `/api/v0/models` where each entry has a `state` field. The
// frontend talks only to the bridge — no direct CLI shell-out from the
// browser.

import { backendCall } from './backend'

export async function listLoadedLmStudioModels(): Promise<string[]> {
  try {
    const data = await backendCall<{ loaded: string[] }>('lmstudio_list_loaded')
    return data.loaded ?? []
  } catch {
    return []
  }
}

/**
 * Load (or RELOAD) a model in LM Studio. When `contextLength` is given the
 * bridge unloads the current instance first and reloads with `lms load -c <N>`,
 * because LM Studio fixes the context window at load time (the OpenAI-compat
 * HTTP API has no per-request num_ctx). Omit it for a plain load.
 */
export async function loadLmStudioModel(model: string, contextLength?: number): Promise<void> {
  await backendCall('lmstudio_load_model', { model, contextLength: contextLength && contextLength > 0 ? contextLength : null })
}

export async function unloadLmStudioModel(model: string): Promise<void> {
  await backendCall('lmstudio_unload_model', { model })
}

export interface LmStudioModelContext {
  /** The context window the model is ACTUALLY running with (null = not loaded). */
  loaded: number | null
  /** The model's maximum context window. */
  max: number | null
  /** LM Studio state, e.g. "loaded" | "not-loaded". */
  state: string | null
}

/**
 * Read a model's real context window from LM Studio's enhanced REST API.
 * `loaded` is the source of truth for the TokenCounter denominator — it's what
 * the chat actually uses, not the model's theoretical max.
 */
export async function getLmStudioModelContext(model: string): Promise<LmStudioModelContext> {
  try {
    return await backendCall<LmStudioModelContext>('lmstudio_model_context', { model })
  } catch {
    return { loaded: null, max: null, state: null }
  }
}
