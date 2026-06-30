import { describe, it, expect } from 'vitest'
import { lmsIdOf, shouldAutoLoadForSelect, lmsAutoLoadContext, LMS_AUTOLOAD_CONTEXT } from '../ModelSelector'
import type { AIModel } from '../../../types/models'

// §18 — focused tests for the LM Studio select-time auto-load decision.
// The full ModelSelector component is hook/store/Tauri-heavy and has no
// render harness, so we test the extracted pure helpers that drive the
// behaviour instead.

function lmsModel(name: string, extra: Record<string, unknown> = {}): AIModel {
  return {
    name,
    model: name,
    size: 0,
    type: 'text',
    provider: 'openai',
    providerName: 'LM Studio',
    ...extra,
  } as AIModel
}

function ollamaModel(name: string): AIModel {
  return {
    name,
    model: name,
    size: 0,
    type: 'text',
    provider: 'ollama',
    providerName: 'Ollama',
  } as AIModel
}

describe('lmsIdOf', () => {
  it('uses lmsKey when present', () => {
    const m = lmsModel('Qwen3', { lmsKey: 'qwen/qwen3-gguf' })
    expect(lmsIdOf(m)).toBe('qwen/qwen3-gguf')
  })

  it('falls back to model name when lmsKey is absent', () => {
    expect(lmsIdOf(lmsModel('Qwen3'))).toBe('Qwen3')
  })

  it('ignores a non-string lmsKey', () => {
    const m = lmsModel('Qwen3', { lmsKey: 123 })
    expect(lmsIdOf(m)).toBe('Qwen3')
  })

  // Regression (live E2E 2026-06-01): real LM Studio models carry LU's routing
  // prefix "openai::<key>". lmsIdOf MUST strip it so `lms load` gets the bare
  // key and the loaded-check compares like-for-like. Before the fix the prefixed
  // id reached `lms load` (matches nothing → hung pre-`-y`, exit 1 post-`-y`) and
  // never matched the loaded set. The earlier fixtures used bare names, which is
  // why the bug shipped — these lock the real shape in.
  it('strips the openai:: routing prefix from the model name', () => {
    expect(lmsIdOf(lmsModel('openai::qwen2.5-0.5b-instruct@q4_k_m')))
      .toBe('qwen2.5-0.5b-instruct@q4_k_m')
  })

  it('strips the prefix from lmsKey too, and keeps @quant / slashes intact', () => {
    expect(lmsIdOf(lmsModel('Display', { lmsKey: 'openai::qwen/qwen2.5-vl-7b' })))
      .toBe('qwen/qwen2.5-vl-7b')
  })

  it('leaves an unprefixed name untouched (no false strip on a bare key)', () => {
    expect(lmsIdOf(lmsModel('qwen2.5-0.5b-instruct@q4_k_m')))
      .toBe('qwen2.5-0.5b-instruct@q4_k_m')
  })
})

describe('shouldAutoLoadForSelect', () => {
  it('returns true for an UNloaded LM Studio model', () => {
    expect(shouldAutoLoadForSelect(lmsModel('m1'), new Set())).toBe(true)
  })

  it('returns false for an already-loaded LM Studio model', () => {
    expect(shouldAutoLoadForSelect(lmsModel('m1'), new Set(['m1']))).toBe(false)
  })

  it('matches the loaded set on lmsKey, not the display name', () => {
    const m = lmsModel('Qwen 3', { lmsKey: 'qwen/qwen3' })
    expect(shouldAutoLoadForSelect(m, new Set(['qwen/qwen3']))).toBe(false)
    expect(shouldAutoLoadForSelect(m, new Set(['Qwen 3']))).toBe(true)
  })

  // Regression: a prefixed model name must match a BARE key in the loaded set
  // (LM Studio's /api/v0/models reports bare keys). Pre-fix this returned true
  // even when loaded → the row re-loaded on every select.
  it('matches a bare loaded key against a prefixed model name', () => {
    const m = lmsModel('openai::qwen2.5-0.5b-instruct@q4_k_m')
    expect(shouldAutoLoadForSelect(m, new Set(['qwen2.5-0.5b-instruct@q4_k_m']))).toBe(false)
    expect(shouldAutoLoadForSelect(m, new Set())).toBe(true)
  })

  it('returns false for Ollama models regardless of loaded set', () => {
    expect(shouldAutoLoadForSelect(ollamaModel('llama3'), new Set())).toBe(false)
    expect(shouldAutoLoadForSelect(ollamaModel('llama3'), new Set(['llama3']))).toBe(false)
  })

  it('returns false for a cloud model (no providerName match)', () => {
    const cloud = {
      name: 'gpt-4', model: 'gpt-4', size: 0, type: 'text',
      provider: 'openai', providerName: 'OpenRouter',
    } as AIModel
    expect(shouldAutoLoadForSelect(cloud, new Set())).toBe(false)
  })
})

// Root cause proven live 2026-06-12: `lms load` without `-c` pins the instance
// at LM Studio's 4096 default, which overflows the moment tool schemas are in
// play → opaque "LM Studio: Request failed" (a 4xx, so no retry). These lock in
// that LU always asks for a usable window, capped by the model's real max.
describe('lmsAutoLoadContext', () => {
  it('caps a huge model max at the 16K auto-load window', () => {
    // gemma-3-4b reports max 131072 — we must NOT load it that big (KV-cache
    // VRAM blowup); 16K is the sweet spot.
    expect(lmsAutoLoadContext(lmsModel('gemma-3-4b', { contextLength: 131072 }))).toBe(LMS_AUTOLOAD_CONTEXT)
    expect(LMS_AUTOLOAD_CONTEXT).toBe(16384)
  })

  it('uses the model max when it is SMALLER than the window (never over-asks)', () => {
    expect(lmsAutoLoadContext(lmsModel('tiny', { contextLength: 8192 }))).toBe(8192)
  })

  it('returns exactly the window when max equals it', () => {
    expect(lmsAutoLoadContext(lmsModel('m', { contextLength: 16384 }))).toBe(16384)
  })

  it('falls back to the window when contextLength is missing', () => {
    expect(lmsAutoLoadContext(lmsModel('m'))).toBe(LMS_AUTOLOAD_CONTEXT)
  })

  it('falls back to the window for a zero / bogus contextLength (never loads 0)', () => {
    expect(lmsAutoLoadContext(lmsModel('m', { contextLength: 0 }))).toBe(LMS_AUTOLOAD_CONTEXT)
    expect(lmsAutoLoadContext(lmsModel('m', { contextLength: -5 }))).toBe(LMS_AUTOLOAD_CONTEXT)
  })
})
