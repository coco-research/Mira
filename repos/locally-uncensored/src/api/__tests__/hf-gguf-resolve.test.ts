/**
 * Unit tests for `selectGgufFromTree` — the pure resolver that turns a
 * HuggingFace repo file tree into the exact GGUF file(s) to download.
 *
 * Why it exists: the old path guessed ONE single-file name from the repo name
 * and downloaded that URL blindly. Three real layouts broke it (all confirmed
 * against the live HF API for bartowski/Llama-3.3-70B-Instruct-abliterated-GGUF):
 *   1. quant in a subfolder, not at root  (Q5_K_M/<file>.gguf)
 *   2. quant split into multiple parts     (-00001-of-00002.gguf)
 *   3. guessed single-file name is a 404
 * David: "mach dann alle hf models bestätigt korrekt downloaden."
 *
 * The tree fixtures below mirror the real shapes returned by
 *   https://huggingface.co/api/models/<repo>/tree/main?recursive=true
 */
import { describe, it, expect } from 'vitest'
import { selectGgufFromTree, type HfTreeEntry } from '../discover'

const REPO = 'bartowski/Llama-3.3-70B-Instruct-abliterated-GGUF'

// Real-shape tree: single-file quants at root + larger quants split into a
// quant-named subfolder (exactly what the live API returns for this repo).
const tree70b: HfTreeEntry[] = [
  { type: 'directory', path: 'Llama-3.3-70B-Instruct-abliterated-Q5_K_M' },
  { type: 'file', path: 'README.md', size: 1234 },
  { type: 'file', path: 'Llama-3.3-70B-Instruct-abliterated-Q4_K_M.gguf', size: 42_520_398_912 },
  { type: 'file', path: 'Llama-3.3-70B-Instruct-abliterated-Q2_K.gguf', size: 26_375_113_792 },
  { type: 'file', path: 'Llama-3.3-70B-Instruct-abliterated-Q2_K_L.gguf', size: 27_401_161_792 },
  { type: 'file', path: 'Llama-3.3-70B-Instruct-abliterated-Q6_K/Llama-3.3-70B-Instruct-abliterated-Q6_K-00001-of-00002.gguf', size: 39_953_848_160 },
  { type: 'file', path: 'Llama-3.3-70B-Instruct-abliterated-Q6_K/Llama-3.3-70B-Instruct-abliterated-Q6_K-00002-of-00002.gguf', size: 17_934_300_608 },
  // intentionally out of order to prove sorting
  { type: 'file', path: 'Llama-3.3-70B-Instruct-abliterated-Q5_K_M/Llama-3.3-70B-Instruct-abliterated-Q5_K_M-00002-of-00002.gguf', size: 9_962_267_232 },
  { type: 'file', path: 'Llama-3.3-70B-Instruct-abliterated-Q5_K_M/Llama-3.3-70B-Instruct-abliterated-Q5_K_M-00001-of-00002.gguf', size: 39_987_555_008 },
]

describe('selectGgufFromTree', () => {
  it('returns null when the tree has no GGUF files', () => {
    expect(selectGgufFromTree([{ type: 'file', path: 'README.md', size: 1 }], REPO)).toBeNull()
    expect(selectGgufFromTree([], REPO)).toBeNull()
  })

  it('resolves a single-file root quant (no sharding)', () => {
    const r = selectGgufFromTree(tree70b, REPO, 'Q4_K_M')
    expect(r).not.toBeNull()
    expect(r!.sharded).toBe(false)
    expect(r!.files).toHaveLength(1)
    expect(r!.files[0].filename).toBe('Llama-3.3-70B-Instruct-abliterated-Q4_K_M.gguf')
    expect(r!.files[0].url).toBe(`https://huggingface.co/${REPO}/resolve/main/Llama-3.3-70B-Instruct-abliterated-Q4_K_M.gguf`)
    expect(r!.quant).toBe('Q4_K_M')
    expect(r!.totalBytes).toBe(42_520_398_912)
  })

  it('resolves ALL parts of a sharded subfolder quant, sorted by part index', () => {
    const r = selectGgufFromTree(tree70b, REPO, 'Q5_K_M')
    expect(r).not.toBeNull()
    expect(r!.sharded).toBe(true)
    expect(r!.files).toHaveLength(2)
    // sorted 00001 before 00002 despite the reversed input order
    expect(r!.files[0].filename).toBe('Llama-3.3-70B-Instruct-abliterated-Q5_K_M-00001-of-00002.gguf')
    expect(r!.files[1].filename).toBe('Llama-3.3-70B-Instruct-abliterated-Q5_K_M-00002-of-00002.gguf')
    // each part keeps its full subfolder path in the URL
    expect(r!.files[0].url).toContain('/Llama-3.3-70B-Instruct-abliterated-Q5_K_M/Llama-3.3-70B-Instruct-abliterated-Q5_K_M-00001-of-00002.gguf')
    expect(r!.totalBytes).toBe(39_987_555_008 + 9_962_267_232)
    expect(r!.quant).toBe('Q5_K_M')
  })

  it('handles a quant with no third segment (Q6_K) — groups + sorts both parts', () => {
    const r = selectGgufFromTree(tree70b, REPO, 'Q6_K')
    expect(r).not.toBeNull()
    expect(r!.sharded).toBe(true)
    expect(r!.files).toHaveLength(2)
    expect(r!.files[0].filename).toContain('-00001-of-00002.gguf')
    expect(r!.files[1].filename).toContain('-00002-of-00002.gguf')
  })

  it('does not confuse Q2_K with Q2_K_L-style neighbours', () => {
    const r = selectGgufFromTree(tree70b, REPO, 'Q2_K')
    expect(r!.sharded).toBe(false)
    expect(r!.files[0].filename).toBe('Llama-3.3-70B-Instruct-abliterated-Q2_K.gguf')
  })

  it('falls back to Q4_K_M when the requested quant is absent', () => {
    const r = selectGgufFromTree(tree70b, REPO, 'Q3_K_S')
    expect(r).not.toBeNull()
    // Q3_K_S not in the tree → default to Q4_K_M
    expect(r!.quant).toBe('Q4_K_M')
    expect(r!.files[0].filename).toBe('Llama-3.3-70B-Instruct-abliterated-Q4_K_M.gguf')
  })

  it('resolves a single file living in a subfolder (not sharded)', () => {
    const tree: HfTreeEntry[] = [
      { type: 'file', path: 'Qwen3.6-35B-Heretic-Q4_K_M/Qwen3.6-35B-Heretic-Q4_K_M.gguf', size: 21_000_000_000 },
    ]
    const r = selectGgufFromTree(tree, 'Youssofal/Qwen3.6-35B-A3B-Abliterated-Heretic-GGUF', 'Q4_K_M')
    expect(r!.sharded).toBe(false)
    expect(r!.files).toHaveLength(1)
    expect(r!.files[0].filename).toBe('Qwen3.6-35B-Heretic-Q4_K_M.gguf')
    expect(r!.files[0].url).toContain('/Qwen3.6-35B-Heretic-Q4_K_M/Qwen3.6-35B-Heretic-Q4_K_M.gguf')
  })

  it('IQ quants are recognised and grouped', () => {
    const tree: HfTreeEntry[] = [
      { type: 'file', path: 'Foo-IQ2_XXS.gguf', size: 100 },
      { type: 'file', path: 'Foo-IQ4_XS.gguf', size: 200 },
    ]
    const r = selectGgufFromTree(tree, 'x/Foo-GGUF', 'IQ4_XS')
    expect(r!.sharded).toBe(false)
    expect(r!.quant).toBe('IQ4_XS')
    expect(r!.files[0].filename).toBe('Foo-IQ4_XS.gguf')
  })
})
