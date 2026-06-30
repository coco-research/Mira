/**
 * hf-to-provider — GGUF quant extraction, Ollama HF refs, and the
 * sharded/incompatible-pull classifier.
 *
 * Regression focus (Aldrich Ironhart, Discord 2026-06-07): unsloth "UD"
 * dynamic quants (Q4_K_XL / Q4_K_XS) were not recognised, so the Ollama HF
 * reference dropped the quant tag entirely.
 */
import { describe, it, expect } from 'vitest'
import { extractGgufQuant, hfUrlToOllamaRef, isShardedOrIncompatibleGguf } from '../hf-to-provider'

describe('extractGgufQuant', () => {
  it('reads classic K-quants', () => {
    expect(extractGgufQuant('model-Q4_K_M.gguf')).toBe('Q4_K_M')
    expect(extractGgufQuant('model.Q5_K_S.gguf')).toBe('Q5_K_S')
    expect(extractGgufQuant('model_Q3_K_L.gguf')).toBe('Q3_K_L')
  })
  it('reads unsloth UD dynamic quants (the konata/Aldrich regression)', () => {
    expect(extractGgufQuant('gemma-4-26B-A4B-it-UD-Q4_K_XL.gguf')).toBe('Q4_K_XL')
    expect(extractGgufQuant('model-UD-Q4_K_XS.gguf')).toBe('Q4_K_XS')
  })
  it('reads bare K-quants, Q*_0/1, IQ, and float types', () => {
    expect(extractGgufQuant('model-Q6_K.gguf')).toBe('Q6_K')
    expect(extractGgufQuant('model-Q8_0.gguf')).toBe('Q8_0')
    expect(extractGgufQuant('model-IQ4_XS.gguf')).toBe('IQ4_XS')
    expect(extractGgufQuant('model-F16.gguf')).toBe('F16')
  })
  it('returns undefined when no quant token is present', () => {
    expect(extractGgufQuant('model.gguf')).toBeUndefined()
    expect(extractGgufQuant('not-a-gguf.txt')).toBeUndefined()
  })
})

describe('hfUrlToOllamaRef', () => {
  it('builds hf.co/<user>/<repo>:<quant> from a HF blob URL + filename', () => {
    const url = 'https://huggingface.co/unsloth/gemma-4-26B-A4B-it-GGUF/resolve/main/gemma-4-26B-A4B-it-UD-Q4_K_XL.gguf'
    // With the XL fix the quant tag is now preserved instead of dropped.
    expect(hfUrlToOllamaRef(url, 'gemma-4-26B-A4B-it-UD-Q4_K_XL.gguf'))
      .toBe('hf.co/unsloth/gemma-4-26B-A4B-it-GGUF:Q4_K_XL')
  })
  it('falls back to a tag-less ref when the filename has no recognised quant', () => {
    const url = 'https://huggingface.co/acme/Some-Model-GGUF/resolve/main/model.gguf'
    expect(hfUrlToOllamaRef(url, 'model.gguf')).toBe('hf.co/acme/Some-Model-GGUF')
  })
  it('returns null for a non-HuggingFace URL', () => {
    expect(hfUrlToOllamaRef('https://example.com/model.gguf', 'model.gguf')).toBeNull()
  })
})

describe('isShardedOrIncompatibleGguf', () => {
  it('flags sharded / split / not-compatible pull errors', () => {
    expect(isShardedOrIncompatibleGguf('Error: repository is not GGUF or is not compatible with llama.cpp')).toBe(true)
    expect(isShardedOrIncompatibleGguf('model is split into multiple parts')).toBe(true)
    expect(isShardedOrIncompatibleGguf('sharded gguf not supported (ollama/ollama#5245)')).toBe(true)
  })
  it('does NOT flag a bare HTTP 400 (handled separately as out-of-date Ollama)', () => {
    expect(isShardedOrIncompatibleGguf('ollama: 400')).toBe(false)
  })
  it('does NOT flag unrelated errors', () => {
    expect(isShardedOrIncompatibleGguf('connection refused')).toBe(false)
  })
})
