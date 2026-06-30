/**
 * Model Compatibility Tests — Provider-Aware
 *
 * Tests agent mode compatibility across all provider types.
 * Run: npx vitest run src/api/__tests__/model-compatibility.test.ts
 */
import { describe, it, expect } from 'vitest'
import {
  isAgentCompatible,
  getToolCallingStrategy,
  getRecommendedAgentModels,
} from '../../lib/model-compatibility'

// ── isAgentCompatible ───────────────────────────────────────────

describe('isAgentCompatible', () => {
  describe('Ollama models (no prefix)', () => {
    it('hermes3 is compatible', () => {
      expect(isAgentCompatible('hermes3:8b')).toBe(true)
      expect(isAgentCompatible('hermes3:70b')).toBe(true)
    })

    it('qwen models are compatible', () => {
      expect(isAgentCompatible('qwen2.5:7b')).toBe(true)
      expect(isAgentCompatible('qwen3:8b')).toBe(true)
    })

    it('llama models are compatible', () => {
      expect(isAgentCompatible('llama3.1:8b')).toBe(true)
      expect(isAgentCompatible('llama3.2:3b')).toBe(true)
      expect(isAgentCompatible('llama3.3:70b')).toBe(true)
      expect(isAgentCompatible('llama4:8b')).toBe(true)
    })

    it('mistral models are compatible', () => {
      expect(isAgentCompatible('mistral:7b')).toBe(true)
      expect(isAgentCompatible('mistral-nemo:12b')).toBe(true)
      expect(isAgentCompatible('mistral-small:22b')).toBe(true)
    })

    it('gemma4 models are compatible (native tool calling)', () => {
      expect(isAgentCompatible('gemma4:e2b')).toBe(true)
      expect(isAgentCompatible('gemma4:e4b')).toBe(true)
      expect(isAgentCompatible('gemma4:26b')).toBe(true)
      expect(isAgentCompatible('gemma4:31b')).toBe(true)
      expect(isAgentCompatible('gemma4:26b-a4b-it-q4_K_M')).toBe(true)
    })

    it('qwen3-coder models are compatible (native tool calling)', () => {
      expect(isAgentCompatible('qwen3-coder:30b')).toBe(true)
      expect(isAgentCompatible('qwen3-coder:latest')).toBe(true)
    })

    it('qwen3-coder abliterated retains native tool calling', () => {
      expect(isAgentCompatible('huihui_ai/qwen3-coder-abliterated:latest')).toBe(true)
    })

    it('other compatible models', () => {
      expect(isAgentCompatible('command-r:35b')).toBe(true)
      expect(isAgentCompatible('phi-4:14b')).toBe(true)
      expect(isAgentCompatible('gemma3:12b')).toBe(true)
      expect(isAgentCompatible('nemotron:8b')).toBe(true)
    })

    it('abliterated variants of agent-capable bases ARE compatible', () => {
      // Discord-reported by diimmortalis (2026-04-25): the previous heuristic
      // only allow-listed a tiny set of abliterated bases (qwen3-coder, hermes)
      // and silently disabled the Agent toggle for everyone else, including
      // popular uncensored Qwen 3.5 / Llama 3.1 / Qwen 2.5 builds. We now
      // strip the abliterated/uncensored suffix and check the same
      // AGENT_COMPATIBLE list as the vanilla path.
      expect(isAgentCompatible('mannix/llama3.1-8b-abliterated:q5_K_M')).toBe(true)
      expect(isAgentCompatible('huihui_ai/qwen2.5-abliterated:7b')).toBe(true)
      expect(isAgentCompatible('LEONW24/Qwen3.5-9B-Uncensored:Q4_K_M')).toBe(true)
    })

    it('Gemma 4 community-uncensored builds keep agent capability (Bug X, leonsk29 2026-05-24)', () => {
      // The Discord 2026-05-24 report: Agent + Thinking toggles grayed out
      // for every Gemma 4 community variant the Discover tab pulls (TrevorJS,
      // nohurry, Stabhappy, LiconStudio, huihui). Their tag shapes use the
      // dashed-family form `gemma-4-…-it-…-GGUF:Q4_K_M`, which the previous
      // normalizer left as `gemma-4-…` (no match against `gemma4`).
      expect(isAgentCompatible('hf.co/TrevorJS/gemma-4-31B-it-uncensored-GGUF:Q4_K_M')).toBe(true)
      expect(isAgentCompatible('hf.co/nohurry/gemma-4-26B-A4B-it-heretic-GUFF:q4_k_m')).toBe(true)
      expect(isAgentCompatible('hf.co/Stabhappy/gemma-4-31B-it-heretic-Gguf:Q4_K_M')).toBe(true)
      expect(isAgentCompatible('hf.co/LiconStudio/Gemma-4-31B-it-abliterated-GGUF:Q4_K_M')).toBe(true)
      expect(isAgentCompatible('huihui_ai/Qwen3.6-abliterated:35b')).toBe(true)
      // Two-slash hf.co prefix specifically — previously stopped at first slash
      expect(isAgentCompatible('hf.co/mradermacher/Huihui-Qwen3.5-35B-A3B-abliterated-i1-GGUF:Q4_K_M')).toBe(true)
    })

    it('uncensored variants of unknown bases are still NOT compatible', () => {
      // dolphin3 is not in AGENT_COMPATIBLE — strip suffix and check, still no.
      expect(isAgentCompatible('dolphin3-uncensored:8b')).toBe(false)
    })

    it('unknown models are NOT compatible', () => {
      expect(isAgentCompatible('dolphin3:8b')).toBe(false)
      expect(isAgentCompatible('nomic-embed-text:latest')).toBe(false)
    })
  })

  describe('OpenAI models (openai:: prefix)', () => {
    it('all OpenAI models are always compatible', () => {
      expect(isAgentCompatible('openai::gpt-4o')).toBe(true)
      expect(isAgentCompatible('openai::gpt-4o-mini')).toBe(true)
      expect(isAgentCompatible('openai::gpt-3.5-turbo')).toBe(true)
    })

    it('OpenRouter models are compatible', () => {
      expect(isAgentCompatible('openai::meta-llama/llama-3.1-8b')).toBe(true)
      expect(isAgentCompatible('openai::deepseek/deepseek-chat')).toBe(true)
    })

    it('even unknown OpenAI-compat models are compatible', () => {
      expect(isAgentCompatible('openai::some-random-model')).toBe(true)
    })
  })

  describe('Anthropic models (anthropic:: prefix)', () => {
    it('all Anthropic models are always compatible', () => {
      expect(isAgentCompatible('anthropic::claude-opus-4-20250514')).toBe(true)
      expect(isAgentCompatible('anthropic::claude-sonnet-4-20250514')).toBe(true)
      expect(isAgentCompatible('anthropic::claude-haiku-4-5-20251001')).toBe(true)
    })
  })
})

// ── getToolCallingStrategy ──────────────────────────────────────

describe('getToolCallingStrategy', () => {
  it('Ollama compatible models use native', () => {
    expect(getToolCallingStrategy('hermes3:8b')).toBe('native')
    expect(getToolCallingStrategy('qwen2.5:7b')).toBe('native')
    expect(getToolCallingStrategy('llama3.1:8b')).toBe('native')
    expect(getToolCallingStrategy('gemma4:26b')).toBe('native')
    expect(getToolCallingStrategy('gemma4:e4b')).toBe('native')
  })

  it('Ollama abliterated variants of agent-capable bases use native', () => {
    // Same intent as the matching isAgentCompatible test — uncensored llama3.1
    // keeps native tool-calling, the strategy follows.
    expect(getToolCallingStrategy('mannix/llama3.1-8b-abliterated:q5_K_M')).toBe('native')
  })

  it('Ollama unknown models use hermes_xml', () => {
    expect(getToolCallingStrategy('dolphin3:8b')).toBe('hermes_xml')
  })

  it('OpenAI models always use native', () => {
    expect(getToolCallingStrategy('openai::gpt-4o')).toBe('native')
    expect(getToolCallingStrategy('openai::gpt-3.5-turbo')).toBe('native')
    expect(getToolCallingStrategy('openai::any-model')).toBe('native')
  })

  it('Anthropic models always use native', () => {
    expect(getToolCallingStrategy('anthropic::claude-sonnet-4-20250514')).toBe('native')
    expect(getToolCallingStrategy('anthropic::claude-haiku-4-5-20251001')).toBe('native')
  })
})

// ── Recommended Models ──────────────────────────────────────────

describe('getRecommendedAgentModels', () => {
  it('includes local and cloud recommendations', () => {
    const models = getRecommendedAgentModels()
    expect(models.length).toBeGreaterThanOrEqual(4)

    const providers = new Set(models.map(m => m.provider))
    expect(providers.has('ollama')).toBe(true)
    expect(providers.has('anthropic')).toBe(true)
  })

  it('hermes3 is marked as hot', () => {
    const models = getRecommendedAgentModels()
    const hermes = models.find(m => m.name.includes('hermes3'))
    expect(hermes).toBeDefined()
    expect(hermes!.hot).toBe(true)
  })

  it('gemma4 26b MoE is in recommended models', () => {
    const models = getRecommendedAgentModels()
    const gemma4 = models.find(m => m.name.includes('gemma4'))
    expect(gemma4).toBeDefined()
    expect(gemma4!.hot).toBe(true)
    expect(gemma4!.provider).toBe('ollama')
  })

  it('all recommended models are actually compatible', () => {
    const models = getRecommendedAgentModels()
    for (const m of models) {
      expect(isAgentCompatible(m.name), `${m.name} should be compatible`).toBe(true)
    }
  })
})
