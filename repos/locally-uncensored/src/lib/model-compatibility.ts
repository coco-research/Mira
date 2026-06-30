/**
 * Model Compatibility for Agent Mode — now provider-aware.
 *
 * Cloud providers (OpenAI, Anthropic) always support native tool calling.
 * Ollama models need explicit compatibility checks.
 */

import { getProviderIdFromModel } from '../api/providers'
import type { ProviderId } from '../api/providers/types'

const AGENT_COMPATIBLE = [
  // ── Hermes: THE uncensored agent model ──
  'hermes3', 'hermes-3', 'hermes',
  // ── Standard models with native tool calling ──
  'qwen3.6', 'qwen3-coder-next', 'qwen3-coder', 'qwen3', 'qwen2.5',
  'llama3.1', 'llama3.2', 'llama3.3', 'llama4',
  'mistral', 'mistral-nemo', 'mistral-small', 'mistral-large',
  'command-r',
  'phi-4', 'phi4',
  'deepseek-v2.5', 'deepseek-v3',
  'glm4', 'glm-4',
  'gemma3', 'gemma4',
  // IBM Granite — native tool calling (BFCL v3 ~60). 'granite' as a free word
  // matches granite-4.0-micro / granite3.3 etc. after normalizeFamily. Without
  // this, the sub-4GB Granite 4.0 Micro tool-caller had Agent Mode grayed out.
  'granite',
  'nemotron',
]

/**
 * Aggressively normalize a model tag into a comparable "family" key.
 *
 * The Ollama / HuggingFace ecosystem ships the same base under wildly
 * different cosmetic surface forms — `gemma4:e4b`, `gemma-4-it-uncensored`,
 * `huihui_ai/gemma-4-26b-a4b-heretic`, `mradermacher/Gemma-4-31B-it-abliterated-GGUF`.
 * leonsk29 (Discord 2026-05-24) reported Thinking + Agent both grayed out on
 * community uncensored Gemma 4 variants because the previous normalizer only
 * handled the dash-less family form (`gemma4`) and missed the dashed form
 * (`gemma-4`) that mradermacher / TrevorJS / Stabhappy / LiconStudio repos
 * all use. After normalization `gemma-4-it-abliterated-Q4_K_M` and `gemma4`
 * collapse to the same prefix and inherit the family's capability flags.
 *
 * Steps, in order:
 *   1. lowercase
 *   2. drop everything before the first slash (`huihui_ai/...` → `...`)
 *   3. drop GGUF / repo cruft markers (`-GGUF`, `-Imatrix`, `-MAX`)
 *   4. drop tuning / variant markers anywhere (`-abliterated`, `-uncensored`,
 *      `-heretic`, `-instruct`, `-it`, `-chat`, `-base`)
 *   5. drop quant suffixes (`-Q4_K_M`, `.i1-Q4_K_M`, `-IQ2_XXS`, `-UD-Q4_K_XL`)
 *   6. drop the `:tag` part
 *   7. squash `gemma-4` → `gemma4`, `qwen-3` → `qwen3`, `llama-3.1` → `llama3.1`
 *      so the dashed forms match the dash-less family entries
 */
function normalizeFamily(modelName: string): string {
  // Strip the FULL path prefix (greedy up to the last `/`), not just one
  // segment. `hf.co/trevorjs/gemma-4-31B-it-uncensored-GGUF:Q4_K_M` has two
  // slashes — the previous non-greedy strip left `trevorjs/...` behind and
  // the anchored dash-collapse below missed `gemma-4` entirely. Greedy fix
  // covers `hf.co/<user>/<repo>:<tag>`, `<user>/<repo>:<tag>`, and bare tags.
  let s = modelName.toLowerCase().replace(/^.*\//, '')
  // Suffix markers — drop wherever they appear
  s = s
    .replace(/-abliterated/g, '')
    .replace(/-uncensored/g, '')
    .replace(/-heretic/g, '')
    .replace(/-instruct/g, '')
    .replace(/-chat/g, '')
    .replace(/-base/g, '')
    .replace(/-it\b/g, '')
  // Repo cruft (`-gguf`, `-imatrix`, `-max`, `-i1`, `-ud`)
  s = s.replace(/-(gguf|imatrix|max|i1|ud)\b/g, '')
  // Quant suffixes (`-q4_k_m`, `-iq2_xxs`, `-mxfp8`, etc.) — kill from the
  // leftmost `-q\d` / `-iq\d` / `-fp\d` / `-bf\d` to end of string.
  s = s.replace(/[-.](q\d[a-z_0-9]*|iq\d[a-z_0-9]*|fp\d[a-z_0-9]*|bf\d+|nvfp\d+|mxfp\d+)$/i, '')
  // Drop the `:tag` part
  s = s.replace(/:.*$/, '')
  // Family-name dash collapse: gemma-4 -> gemma4, qwen-3 -> qwen3,
  // llama-3.1 -> llama3.1, glm-4 -> glm4, phi-4 -> phi4, deepseek-v3 stays.
  // Apply with /g so the pattern collapses anywhere it appears, not just at
  // string start — `huihui-gemma-4-…` needs to collapse the inner `gemma-4`.
  s = s.replace(/(gemma|qwen|llama|glm|phi)-(\d)/g, '$1$2')
  return s
}

/**
 * Check whether a family token appears as a free-standing word inside a
 * normalized name. We can't use `.startsWith` because community abliterator
 * repos prepend their own marker (`Huihui-Qwen3.5-…`, `mradermacher/Huihui-…`,
 * `coder3101_gemma_4_…`); after the slash strip the actual family is buried
 * mid-string. The match requires a non-alphanumeric boundary on both sides so
 * `mistral` does not collide with `mistralfork`, and `gemma3` does not match
 * inside `pre-gemma3xyz`.
 */
function containsFamily(family: string, normalized: string): boolean {
  const escaped = family.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return new RegExp(`(?:^|[^a-z0-9])${escaped}(?![a-z0-9])`).test(normalized)
}

/**
 * Check if a model supports Agent Mode.
 * Cloud providers always support tools. Ollama needs explicit check.
 *
 * Strategy: normalize the input via `normalizeFamily` then match against
 * the canonical list. See `normalizeFamily` for what the normalizer covers.
 *
 * Earlier versions kept a much shorter `ABLITERATED_NATIVE` allow-list which
 * over-rejected uncensored variants of agent-capable bases (Qwen 3.5 Uncensored,
 * Llama 3.2 Abliterated, Gemma 4 Uncensored, etc.). For modern agent-capable
 * families the abliteration / uncensoring procedure does not break native
 * tool-calling weights, so falling back to the same compatibility list as the
 * vanilla path matches user expectation. If a specific abliterated build is
 * proven to break tools at runtime, the user can simply toggle Agent Mode off.
 */
export function isAgentCompatible(modelName: string | null): boolean {
  if (!modelName) return false
  const providerId = getProviderIdFromModel(modelName)

  // Cloud providers always support tool calling
  if (providerId === 'openai' || providerId === 'anthropic') return true

  const baseName = normalizeFamily(modelName)
  return AGENT_COMPATIBLE.some((f) => containsFamily(f, baseName))
}

export const isToolCallingModel = isAgentCompatible
export const hasNativeToolCalling = isAgentCompatible

/**
 * Models that support Ollama's native `think` parameter.
 * When think=true is sent to a non-thinking model, Ollama returns HTTP 400.
 */
const THINKING_COMPATIBLE = [
  'qwq',
  'deepseek-r1',
  'qwen3.6',     // Qwen 3.6 — thinking preservation
  'qwen3',       // Qwen 3.x has native thinking
  'qwen3.5',
  'qwen3-coder',
  'gemma3',      // Gemma 3+ supports thinking via Ollama
  'gemma4',
]

/**
 * Check if a model supports thinking/chain-of-thought mode.
 * Cloud providers handle it gracefully. Ollama needs explicit support.
 *
 * Uses the shared `normalizeFamily` so dashed forms (`gemma-4-31B-it-abliterated`)
 * and dash-less forms (`gemma4:e4b`) both resolve to the same family key.
 */
export function isThinkingCompatible(modelName: string | null): boolean {
  if (!modelName) return false
  const providerId = getProviderIdFromModel(modelName)
  if (providerId === 'openai' || providerId === 'anthropic') return true

  const baseName = normalizeFamily(modelName)
  return THINKING_COMPATIBLE.some(f => containsFamily(f, baseName))
}

/**
 * Gemma 3/4 are thinking-compatible but their `think: false` path produces
 * plain-text structured planning (`Plan:`, `Constraint Checklist:`,
 * `Confidence Score:`) that has no tags we can strip — the model trained
 * itself to talk its reasoning out loud when forced out of thinking mode.
 *
 * The `think: true` path produces `<|channel|>thought` tags instead, which
 * our thinking-stripper can remove cleanly.
 *
 * So when the user toggles Thinking OFF on a Gemma model, we actually pass
 * `thinking: undefined` (let Ollama default to on), and rely on the stripper
 * + the `keepThinking === false` gate to silently discard the tagged
 * reasoning content from the UI. The user gets the clean final answer; the
 * model doesn't leak a planning preamble.
 */
export function isPlainTextPlanner(modelName: string | null): boolean {
  if (!modelName) return false
  const baseName = normalizeFamily(modelName)
  return containsFamily('gemma3', baseName) || containsFamily('gemma4', baseName)
}

export type ToolCallingStrategy = 'native' | 'template_fix' | 'hermes_xml'

/**
 * Determine tool calling strategy for a model.
 * Cloud providers → native. Ollama → check compatibility.
 */
export function getToolCallingStrategy(modelName: string): ToolCallingStrategy {
  const providerId = getProviderIdFromModel(modelName)

  // Cloud providers always use native tool calling
  if (providerId === 'openai' || providerId === 'anthropic') return 'native'

  // Ollama
  return isAgentCompatible(modelName) ? 'native' : 'hermes_xml'
}

export interface RecommendedModel {
  name: string
  label: string
  reason: string
  hot?: boolean
  provider?: ProviderId
}

export function getRecommendedAgentModels(): RecommendedModel[] {
  return [
    // Local — HOT picks
    { name: 'qwen3.6:latest', label: 'Qwen 3.6 35B MoE', reason: '35B brain, 3B active. Vision + agentic coding + thinking. Brand new.', hot: true, provider: 'ollama' },
    { name: 'qwen3.5:35b-a3b', label: 'Qwen 3.5 35B MoE', reason: '35B brain, 3B active. Best agentic + 256K context. SWE-bench leader.', hot: true, provider: 'ollama' },
    { name: 'gemma4:26b', label: 'Gemma 4 26B MoE', reason: '26B brain, runs like 4B. Native tools + vision. Apache 2.0.', hot: true, provider: 'ollama' },
    { name: 'qwen3-coder:30b', label: 'Qwen3-Coder 30B MoE', reason: 'Built for code + agentic workflows. 256K context.', hot: true, provider: 'ollama' },
    { name: 'hermes3:8b', label: 'Hermes 3 8B', reason: 'Uncensored + native tool calling. Best small agent.', hot: true, provider: 'ollama' },
    // Local — solid picks
    { name: 'deepseek-v3.2', label: 'DeepSeek V3.2', reason: 'Frontier reasoning + tool use. Open-source.', provider: 'ollama' },
    { name: 'glm4.7', label: 'GLM 4.7', reason: 'Strong coding, reasoning, agentic execution.', provider: 'ollama' },
    // Cloud
    { name: 'anthropic::claude-opus-4-20250514', label: 'Claude Opus 4', reason: 'Cloud: most capable agent model.', provider: 'anthropic' },
    { name: 'anthropic::claude-sonnet-4-20250514', label: 'Claude Sonnet 4', reason: 'Cloud: fast + smart tool calling.', provider: 'anthropic' },
  ]
}
