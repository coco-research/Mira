/**
 * isPlainTextPlanner Tests (Bug #80 + Mobile parity)
 *
 * Gemma 3/4 with `think: false` drops into plain-text structured planning
 * ("Plan:", "Constraint Checklist:", "Confidence Score:") instead of
 * emitting strippable tags. `isPlainTextPlanner` identifies those models
 * so callers can pass `thinking: undefined` (Ollama default = tagged
 * thinking) as a bypass.
 *
 * The mobile (remote.rs) JS code uses an identical algorithm.
 *
 * Run: npx vitest run src/lib/__tests__/model-compatibility-planner.test.ts
 */
import { describe, it, expect } from 'vitest'
import { isPlainTextPlanner } from '../model-compatibility'

describe('isPlainTextPlanner', () => {
  describe('positive matches — Gemma 3/4 variants', () => {
    it('matches gemma3', () => {
      expect(isPlainTextPlanner('gemma3')).toBe(true)
    })
    it('matches gemma3:27b', () => {
      expect(isPlainTextPlanner('gemma3:27b')).toBe(true)
    })
    it('matches gemma3:12b-instruct', () => {
      expect(isPlainTextPlanner('gemma3:12b-instruct')).toBe(true)
    })
    it('matches gemma4', () => {
      expect(isPlainTextPlanner('gemma4')).toBe(true)
    })
    it('matches gemma4:31b', () => {
      expect(isPlainTextPlanner('gemma4:31b')).toBe(true)
    })
    it('matches gemma4-abliterated variants', () => {
      expect(isPlainTextPlanner('gemma4-abliterated')).toBe(true)
      expect(isPlainTextPlanner('gemma4-abliterated:8b')).toBe(true)
    })
    it('matches gemma4-uncensored variants', () => {
      expect(isPlainTextPlanner('gemma4-uncensored')).toBe(true)
    })
    it('is case-insensitive', () => {
      expect(isPlainTextPlanner('Gemma4')).toBe(true)
      expect(isPlainTextPlanner('GEMMA3:27B')).toBe(true)
    })
    it('strips single-segment org prefix', () => {
      // v2.4.9 made the prefix strip greedy (last slash), so multi-segment
      // HF refs `hf.co/<org>/<repo>:<tag>` also resolve to the family — that
      // is exactly the shape `pullModel(hf.co/<user>/<repo>:<quant>)` emits,
      // and the old non-greedy strip silently disabled the bypass for every
      // community Gemma 4 download (Bug X, leonsk29 Discord 2026-05-24).
      expect(isPlainTextPlanner('library/gemma4:31b')).toBe(true)
      expect(isPlainTextPlanner('ollama/gemma3:27b')).toBe(true)
      expect(isPlainTextPlanner('hf.co/bartowski/gemma4-27B-it-GGUF:Q4_K_M')).toBe(true)
    })
  })

  describe('negative matches — other models do NOT trigger bypass', () => {
    it('gemma2 → false (not affected)', () => {
      expect(isPlainTextPlanner('gemma2')).toBe(false)
      expect(isPlainTextPlanner('gemma2:9b')).toBe(false)
    })
    it('qwen3 → false (uses <think> tags, stripper works fine)', () => {
      expect(isPlainTextPlanner('qwen3')).toBe(false)
      expect(isPlainTextPlanner('qwen3:32b')).toBe(false)
    })
    it('deepseek-r1 → false', () => {
      expect(isPlainTextPlanner('deepseek-r1')).toBe(false)
    })
    it('qwq → false', () => {
      expect(isPlainTextPlanner('qwq')).toBe(false)
    })
    it('llama3 → false (no thinking at all)', () => {
      expect(isPlainTextPlanner('llama3')).toBe(false)
    })
    it('hermes3 → false', () => {
      expect(isPlainTextPlanner('hermes3')).toBe(false)
    })
    it('empty / null → false', () => {
      expect(isPlainTextPlanner(null)).toBe(false)
      expect(isPlainTextPlanner('')).toBe(false)
    })
  })

  describe('edge cases', () => {
    it('gemma (no version suffix) → false — too ambiguous', () => {
      expect(isPlainTextPlanner('gemma')).toBe(false)
      expect(isPlainTextPlanner('gemma:latest')).toBe(false)
    })
    it('a substring with explicit non-alphanumeric boundaries DOES match', () => {
      // v2.4.9 switched to a word-boundary contains-check (Bug X). A
      // hypothetical "stuff-gemma3-mix" build is most likely a Gemma 3
      // derivative — matching is the safe default, and the `think: undefined`
      // bypass that follows is harmless on a non-thinking model.
      expect(isPlainTextPlanner('stuff-gemma3-mix')).toBe(true)
    })
    it('still does NOT match when the family is wedged into a word (gemma3xyz)', () => {
      // Boundary check is real: alphanumeric chars immediately after the
      // family token break the match so `gemma3xyz` stays false.
      expect(isPlainTextPlanner('gemma3xyz')).toBe(false)
      expect(isPlainTextPlanner('foogemma3')).toBe(false)
    })
    it('gemma3 inside a single-segment org namespace triggers correctly', () => {
      expect(isPlainTextPlanner('mradermacher/gemma3-27b-it-GGUF')).toBe(true)
    })
  })
})
