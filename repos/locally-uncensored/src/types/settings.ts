import type { AgentWorkspace } from './agent-workspace'

export type SearchProvider = 'auto' | 'brave' | 'tavily'

export type CavemanMode = 'off' | 'lite' | 'full' | 'ultra'

export interface Settings {
  apiEndpoint: string
  temperature: number
  topP: number
  topK: number
  maxTokens: number
  theme: 'light' | 'dark'
  onboardingDone: boolean
  /** Master switch for personas. When off, new chats get no persona system
   *  prompt (raw model). Default true. Ported from the uselu web companion. */
  personasEnabled: boolean
  thinkingEnabled: boolean
  /**
   * Small-Model Mode (v2.5.0). Evidence-backed lean profile that maximises
   * tool-call reliability + context retention on small local models (3B-8B,
   * e.g. gemma4:e4b, Llama-3.2-3B, Qwen3-8B). When on it flips: a tighter
   * tool cap + embedding-routing (Knob 1), a lean system prompt (Knob 2),
   * tool-output truncation (Knob 3), and aggressive history compaction
   * (Knob 4). It deliberately does NOT lower num_ctx — research found the
   * num_ctx-as-ceiling fear is largely a myth; the real lever is keeping the
   * actual prompt short (see finding_small_model_tool_calling_research).
   * Default false (big models are unaffected). Manual knob, not auto-forced.
   */
  smallModelMode: boolean
  /**
   * Chat-Tools (v2.5.3, David 2026-06-11). When on (default), PLAIN chat can
   * use a curated set of five tools — web_search, web_fetch, file_write,
   * image_generate, video_generate — without the user flipping the full Agent
   * toggle. A lightweight intent detector routes only tool-worthy messages
   * through the agent executor with that restricted allow-list + a chat-style
   * prompt; ordinary conversation stays on the plain path. Off = plain chat is
   * pure text (the pre-v2.5.3 behaviour); the full Agent toggle still works.
   */
  chatToolsEnabled: boolean
  cavemanMode: CavemanMode
  searchProvider: SearchProvider
  braveApiKey: string
  tavilyApiKey: string
  // Agent budget (Phase 10 v2.4.0) — hard caps that halt a runaway agent.
  /** Hard cap on tool calls per user turn. 0 = unlimited (not recommended). */
  agentMaxToolCalls: number
  /** Hard cap on ReAct loop iterations per user turn. 0 = unlimited. */
  agentMaxIterations: number
  /** Override for the HuggingFace GGUF download directory. Empty = auto-detect from active openai-compat provider (e.g. LM Studio models folder). */
  hfDownloadPathOverride: string
  // Generation timeouts (Bug P v2.4.7 — ake0n_official Discord 2026-05-19,
  // Intel UHD CPU-only setup hit the 20-min cap at sampling 9/25 on a 1024px
  // Juggernaut-XL gen).
  /** Image generation timeout in minutes. Default 20. */
  imageGenTimeoutMinutes: number
  /** Video generation timeout in minutes. Default 60. */
  videoGenTimeoutMinutes: number
  // Bug AA v2.5.0 — Kj103x Discord 2026-05-27. Ollama defaults `num_ctx` to
  // 2048, which silently caps RAG payloads and long-turn chats even on
  // models that support way more. This override is forwarded to Ollama
  // chat/chatWithTools as `options.num_ctx`. 0 = use Ollama default
  // (recommended unless you have a specific reason to override). Other
  // providers ignore this field — they manage context themselves.
  /** User-side context-window override (forwarded as Ollama's num_ctx). 0 = auto. */
  contextWindowOverride: number
  // Bug BB v2.5.0 — BobbyT Discord 2026-05-26. GPU vendor + indices to
  // forward as CUDA_VISIBLE_DEVICES / HIP_VISIBLE_DEVICES /
  // ONEAPI_DEVICE_SELECTOR on next Ollama / ComfyUI spawn. "auto" + empty
  // = no env-var, runtime picks default (pre-v2.5.0 behaviour). Used on
  // multi-vendor / multi-GPU systems (e.g. BobbyT's AMD RX 6800XT + Intel
  // Arc Pro B60 where he wants to pin the Arc).
  /** Selected GPU vendor for env-var family ("auto" | "nvidia" | "amd" | "intel"). */
  gpuVendor: 'auto' | 'nvidia' | 'amd' | 'intel'
  /** Zero-based, vendor-scoped indices of GPUs to expose. Empty = all. */
  gpuIndices: number[]
  // Feature EE v2.5.0 — VRAM hand-off for the image/video generation MCP tool.
  // When the agent generates an image/video via ComfyUI, the local text model
  // and the ComfyUI model both want the GPU. This governs whether LU evicts the
  // resident Ollama text model from VRAM for the duration of the generation
  // (then reloads it afterwards) to avoid an OOM on single-GPU machines.
  //   'auto'   — evict only when (text VRAM + estimated model footprint) won't
  //              fit in total VRAM. Unknown sizes → don't evict (default).
  //   'always' — always evict a resident local text model before generating.
  //   'never'  — never evict (accept a possible OOM; for users who manage VRAM
  //              themselves or run text + image on separate GPUs).
  // Only applies to a LOCAL Ollama text model — cloud/remote models hold no
  // local VRAM and are always skipped.
  /** VRAM exclusivity policy for image/video generation. Default 'auto'. */
  exclusiveVramMode: 'auto' | 'always' | 'never'
  // ── v2.5.0 Codex sprint A/B/C settings (ported from uselu) ──────
  /**
   * Codex Architect/Editor split. When on, a separate `codexArchitectModel`
   * runs first to produce a structured plan (no tools, plan only); the
   * regular Codex model then applies the plan with tool access. Aider-style
   * — empirically ~30% better edit accuracy on multi-file refactors.
   */
  codexArchitectMode: boolean
  /**
   * Prefixed model name (e.g. `ollama::qwen-coder:32b`) used for the
   * Architect pass when `codexArchitectMode` is true. Empty = fall back to
   * the active Codex model. Local-first by design: the picker only
   * surfaces non-local options when `codexArchitectAllowCloud` is true.
   */
  codexArchitectModel: string
  /**
   * Explicit opt-in to allow third-party cloud endpoints (Anthropic,
   * OpenAI, OpenRouter) as the Architect model. Default false — forces
   * the user to acknowledge that planning steps would leave the machine.
   */
  codexArchitectAllowCloud: boolean
  /**
   * Repo-Map pre-fetch. When on, Codex calls the bridge `repo_map` command
   * before each turn and injects the top-N ranked files (PageRank over the
   * import graph) into the editor system prompt.
   */
  codexRepoMapEnabled: boolean
  /**
   * Top-N cap for the injected repo map. Bigger maps eat more context;
   * 20 is a balanced default for ~5k-file repos. Clamped to bridge's
   * own [1, 200] range.
   */
  codexRepoMapLimit: number
  /**
   * Multi-File Stage-and-Approve. When on, Codex `file_write` calls don't
   * touch the disk — they queue as "pending changes" the user reviews and
   * applies (or rejects) per-file.
   */
  codexStageMode: boolean
  /**
   * Code-Review mode. When on, Codex runs read-only — every `file_write`
   * and `shell_execute`-style call is blocked with a friendly message and
   * the model is steered into "inline comments only" by a switched system
   * prompt. Use for PR-pre-check runs where you do not want the agent
   * touching anything.
   */
  codexReviewMode: boolean
  /**
   * Shared default workspace for Codex AND Agent (Underlying refactor —
   * workspace unification). When set, both surfaces resolve relative paths
   * against this folder by default; a per-chat override wins when present.
   * Null = no default — keeps Agent prompting on first chat and Codex
   * falling back to the per-thread cwd.
   */
  defaultWorkspace: AgentWorkspace | null
  /**
   * User profile picture as a base64 data URL (downscaled to ≤256px PNG on
   * upload so it stays small in persisted state). Empty string = show the
   * default user icon. Rendered next to the user's chat / code / agent
   * messages. The AI's avatar is always the LU monogram (not user-settable).
   */
  userAvatarDataUrl: string
  // ── v9 (v2.5.3) — Model-Picker preferences ────────────────────────
  // Saved via the in-tool-call model picker's save icon ("für nächste
  // Prompts übernommen"). '' = nothing saved → the picker shows before the
  // VRAM swap on the next generation. Video keeps two slots because the
  // capability sets are disjoint: SVD/FramePack can't do T2V, Wan 1.3B
  // can't do I2V — one shared slot would silently mismatch.
  /** Preferred ComfyUI checkpoint for image generation ('' = ask). */
  preferredImageModel: string
  /** Preferred text-to-video model ('' = ask). */
  preferredVideoT2VModel: string
  /** Preferred image-to-video model ('' = ask). */
  preferredVideoI2VModel: string
}

export interface Persona {
  id: string
  name: string
  icon: string
  systemPrompt: string
  isBuiltIn: boolean
}

// Voice settings (sttEnabled, ttsEnabled, ttsVoice, ttsRate, ttsPitch) are
// managed in src/stores/voiceStore.ts via the dedicated Zustand voice store
// with persistence.
