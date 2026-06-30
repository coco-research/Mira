import { describe, it, expect, beforeEach } from 'vitest'
import { useProviderStore } from '../../../stores/providerStore'
import {
  isLocalModel,
  isLocalModelByName,
  partitionByLocality,
} from '../model-locality'
import type { AIModel } from '../../../types/models'

function model(name: string, provider: AIModel['provider'], extra: Partial<AIModel> = {}): AIModel {
  return {
    name,
    model: name,
    provider,
    providerName: provider,
    type: 'text',
    size: 0,
    ...extra,
  } as AIModel
}

describe('isLocalModel', () => {
  beforeEach(() => {
    // Reset OpenAI provider config to a known state so the
    // OpenAI-compat branch is deterministic per test.
    useProviderStore.setState((s) => ({
      providers: {
        ...s.providers,
        openai: {
          id: 'openai',
          name: 'LM Studio',
          baseUrl: 'http://localhost:1234/v1',
          apiKey: '',
          enabled: true,
          isLocal: true,
        },
      },
    }))
  })

  it('ollama is always local', () => {
    expect(isLocalModel(model('qwen', 'ollama'))).toBe(true)
  })

  it('anthropic is never local', () => {
    expect(isLocalModel(model('claude', 'anthropic'))).toBe(false)
  })

  it('openai-compat is local when the configured endpoint is local (LM Studio)', () => {
    expect(isLocalModel(model('qwen-coder', 'openai'))).toBe(true)
  })

  it('openai-compat is cloud when the configured endpoint is OpenAI/OpenRouter', () => {
    useProviderStore.setState((s) => ({
      providers: {
        ...s.providers,
        openai: {
          ...s.providers.openai,
          baseUrl: 'https://api.openai.com/v1',
          isLocal: false,
        },
      },
    }))
    expect(isLocalModel(model('gpt-4o', 'openai'))).toBe(false)
  })
})

describe('isLocalModelByName', () => {
  beforeEach(() => {
    useProviderStore.setState((s) => ({
      providers: {
        ...s.providers,
        openai: {
          id: 'openai',
          name: 'LM Studio',
          baseUrl: 'http://localhost:1234/v1',
          apiKey: '',
          enabled: true,
          isLocal: true,
        },
      },
    }))
  })

  it('unprefixed name = legacy Ollama, treated as local', () => {
    expect(isLocalModelByName('qwen-coder:32b')).toBe(true)
  })

  it('ollama:: prefix → local', () => {
    expect(isLocalModelByName('ollama::qwen:7b')).toBe(true)
  })

  it('anthropic:: prefix → cloud regardless of provider settings', () => {
    expect(isLocalModelByName('anthropic::claude-sonnet-4-5')).toBe(false)
  })

  it('openai:: prefix follows the configured isLocal flag', () => {
    expect(isLocalModelByName('openai::qwen-coder')).toBe(true)
    useProviderStore.setState((s) => ({
      providers: {
        ...s.providers,
        openai: { ...s.providers.openai, isLocal: false, baseUrl: 'https://openrouter.ai' },
      },
    }))
    expect(isLocalModelByName('openai::deepseek')).toBe(false)
  })

  it('returns false for empty / nullish names', () => {
    expect(isLocalModelByName('')).toBe(false)
    // @ts-expect-error — defensive guard
    expect(isLocalModelByName(undefined)).toBe(false)
  })
})

describe('partitionByLocality', () => {
  beforeEach(() => {
    useProviderStore.setState((s) => ({
      providers: {
        ...s.providers,
        openai: {
          id: 'openai',
          name: 'LM Studio',
          baseUrl: 'http://localhost:1234/v1',
          apiKey: '',
          enabled: true,
          isLocal: true,
        },
      },
    }))
  })

  it('groups Ollama + local OpenAI under local; anthropic under cloud', () => {
    const out = partitionByLocality([
      model('qwen', 'ollama'),
      model('hermes', 'openai'),
      model('claude', 'anthropic'),
    ])
    expect(out.local.map((m) => m.name)).toEqual(['qwen', 'hermes'])
    expect(out.cloud.map((m) => m.name)).toEqual(['claude'])
  })
})
