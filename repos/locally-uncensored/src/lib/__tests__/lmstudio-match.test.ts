import { describe, it, expect } from 'vitest'
import { matchesLmStudioInstalled, modelIdentity, extractQuant, type InstalledModelLike } from '../lmstudio-match'

const lms = (id: string, field: 'model' | 'name' | 'lmsKey' = 'model'): InstalledModelLike => ({
  provider: 'openai',
  providerName: 'LM Studio',
  [field]: id,
})

describe('matchesLmStudioInstalled — exact / quant-precise matches (Bug Y/b)', () => {
  it('matches the older exact full-basename id form', () => {
    expect(matchesLmStudioInstalled('Hermes-3-Llama-3.1-8B.Q4_K_M.gguf', [lms('hermes-3-llama-3.1-8b.q4_k_m.gguf')])).toBe(true)
  })
  it('matches via a publisher/ path suffix', () => {
    expect(matchesLmStudioInstalled('Hermes-3-Llama-3.1-8B.Q4_K_M.gguf', [lms('mradermacher/hermes-3-llama-3.1-8b.q4_k_m')])).toBe(true)
  })
  it('matches the key@quant id form against the SAME quant', () => {
    expect(matchesLmStudioInstalled('Qwen2.5-0.5B-Instruct-Q4_K_M.gguf', [lms('qwen2.5-0.5b-instruct@q4_k_m')])).toBe(true)
  })
  it('also reads the lmsKey field', () => {
    expect(matchesLmStudioInstalled('Qwen2.5-0.5B-Instruct-Q4_K_M.gguf', [lms('qwen2.5-0.5b-instruct@q4_k_m', 'lmsKey')])).toBe(true)
  })
  it('matches a quant-LESS Discover entry from a quant-less id (generic row)', () => {
    expect(matchesLmStudioInstalled('Qwen2.5-VL-7B-Instruct.gguf', [lms('qwen/qwen2.5-vl-7b')])).toBe(true)
  })
})

describe('matchesLmStudioInstalled — NO false positives (v2.5.0 adversarial-audit regression guards)', () => {
  it('does NOT light a DIFFERENT quant of the same model (q4 id vs q8 row)', () => {
    expect(matchesLmStudioInstalled('Qwen2.5-0.5B-Instruct-Q8_0.gguf', [lms('qwen2.5-0.5b-instruct@q4_k_m')])).toBe(false)
  })
  it('does NOT light quant-specific rows from a COLLAPSED quant-less id — the live over-match', () => {
    // LM Studio reports "qwen3.6-27b" (one quant on disk, no @quant). The curated
    // list has 7 quant rows; installing one must NOT badge the siblings.
    expect(matchesLmStudioInstalled('Qwen3.6-27B-Q4_K_M.gguf', [lms('qwen3.6-27b')])).toBe(false)
    expect(matchesLmStudioInstalled('Qwen3.6-27B-Q8_0.gguf', [lms('qwen3.6-27b')])).toBe(false)
    expect(matchesLmStudioInstalled('Qwen3.6-27B-Q5_K_M.gguf', [lms('qwen3.6-27b')])).toBe(false)
  })
  it('does NOT collapse genuinely different finetunes (abliterated vs plain)', () => {
    expect(matchesLmStudioInstalled('Qwen3-8B-abliterated.Q4_K_M.gguf', [lms('qwen3-8b@q4_k_m')])).toBe(false)
  })
  it('does NOT light a different model (coder vs vl)', () => {
    expect(matchesLmStudioInstalled('Qwen2.5-VL-7B-Instruct-Q4_K_M.gguf', [lms('qwen2.5-coder-7b-instruct@q4_k_m')])).toBe(false)
  })
  it('ignores non-LM-Studio (ollama) installed entries', () => {
    expect(matchesLmStudioInstalled('Qwen2.5-0.5B-Instruct-Q4_K_M.gguf', [{ provider: 'ollama', model: 'qwen2.5-0.5b-instruct' }])).toBe(false)
  })
  it('empty filename never matches', () => {
    expect(matchesLmStudioInstalled('', [lms('qwen/qwen2.5-vl-7b')])).toBe(false)
  })
})

describe('extractQuant + modelIdentity', () => {
  it('extractQuant pulls the trailing quant tag', () => {
    expect(extractQuant('Qwen3.6-27B-Q4_K_M.gguf')).toBe('q4km')
    expect(extractQuant('qwen2.5-0.5b-instruct@q4_k_m')).toBe('q4km')
    expect(extractQuant('zai-org_GLM-4.7-Flash-IQ2_M.gguf')).toBe('iq2m')
    expect(extractQuant('qwen/qwen2.5-vl-7b')).toBe(null)
  })
  it('modelIdentity drops publisher, quant, decoration + separators', () => {
    expect(modelIdentity('Qwen2.5-VL-7B-Instruct-Q4_K_M.gguf')).toBe('qwen25vl7b')
    expect(modelIdentity('qwen/qwen2.5-vl-7b')).toBe('qwen25vl7b')
  })
})
