/**
 * Thinking-Stripper Tests
 *
 * Validates the universal stripper that runs during streaming to ensure
 * raw reasoning markup never reaches the user bubble regardless of what
 * the model emits. The mobile (remote.rs) JS code mirrors this exact
 * algorithm — passing these tests means the mobile helper is also correct.
 *
 * Covers:
 * - stripAllThinkingTags (full strip — used when Thinking OFF)
 * - stripNonCanonicalTags (strip non-<think> only — used inside state-machine)
 * - finalStripThinkingTags (end-of-stream safety pass)
 *
 * Bug history in scope:
 * - #79b: non-canonical tag stripper (Gemma <|channel|>thought)
 * - #80: Gemma plain-text planner bypass (separate fix, but related)
 *
 * Run: npx vitest run src/lib/__tests__/thinking-stripper.test.ts
 */
import { describe, it, expect } from 'vitest'
import {
  stripAllThinkingTags,
  stripNonCanonicalTags,
  finalStripThinkingTags,
} from '../thinking-stripper'

describe('thinking-stripper', () => {
  describe('stripAllThinkingTags — full strip', () => {
    it('empty content passes through', () => {
      expect(stripAllThinkingTags('')).toBe('')
    })

    it('content with no thinking tags passes through', () => {
      expect(stripAllThinkingTags('Hello, here is the answer.')).toBe(
        'Hello, here is the answer.'
      )
    })

    it('removes a full <thought>…</thought> block', () => {
      const input = 'Before <thought>internal reasoning</thought> After'
      expect(stripAllThinkingTags(input)).toBe('Before  After')
    })

    it('removes a full <reasoning>…</reasoning> block', () => {
      const input = '<reasoning>step 1\nstep 2</reasoning>Answer!'
      expect(stripAllThinkingTags(input)).toBe('Answer!')
    })

    it('removes <reflect>…</reflect>', () => {
      expect(stripAllThinkingTags('x<reflect>hmm</reflect>y')).toBe('xy')
    })

    it('removes <deepthink>…</deepthink>', () => {
      expect(stripAllThinkingTags('x<deepthink>deep</deepthink>y')).toBe('xy')
    })

    it('removes multiple blocks in one buffer', () => {
      const input = '<thought>a</thought>mid<reasoning>b</reasoning>end'
      expect(stripAllThinkingTags(input)).toBe('midend')
    })

    it('removes Gemma <|channel|>thought … </channel|> block', () => {
      // Real closing form the stripper supports: `</channel>` with optional
      // trailing pipe (BLOCK_PATTERN: `<\/\|?channel\|?>`).
      const input =
        'prefix <|channel|>thought\nPlan step\n</channel|> answer'
      const out = stripAllThinkingTags(input)
      expect(out).not.toContain('<|channel|>')
      expect(out).not.toContain('</channel|>')
      expect(out).toContain('prefix')
      expect(out).toContain('answer')
    })

    it('also handles </channel> (no trailing pipe)', () => {
      const input = 'x <|channel|>thought\nplan\n</channel> y'
      const out = stripAllThinkingTags(input)
      expect(out).not.toContain('<|channel|>')
      expect(out).not.toContain('</channel>')
    })

    it('removes orphan opening channel tag (no close yet in stream)', () => {
      // Mid-stream the close hasn't arrived; the opener must still be
      // stripped so the UI never shows the "thought" marker.
      const input = 'Before <|channel|>thought more text'
      const out = stripAllThinkingTags(input)
      expect(out).not.toContain('<|channel|>')
      expect(out).not.toContain('thought')
      expect(out).toContain('Before')
    })

    it('is case-insensitive on tag name', () => {
      const input = '<THOUGHT>x</THOUGHT>answer'
      expect(stripAllThinkingTags(input)).toBe('answer')
    })

    it('handles multi-line tag content', () => {
      const input = '<thought>\nline 1\nline 2\nline 3\n</thought>\nDone.'
      expect(stripAllThinkingTags(input)).toBe('\nDone.')
    })
  })

  describe('stripNonCanonicalTags — leaves <think> alone', () => {
    it('preserves canonical <think>…</think> block', () => {
      // This one is handled by the char-state-machine; the stripper must
      // NOT remove it or the machine will never see the open marker.
      const input = '<think>pondering</think>Answer'
      expect(stripNonCanonicalTags(input)).toBe(input)
    })

    it('still removes <thought>…</thought>', () => {
      expect(stripNonCanonicalTags('<thought>x</thought>y')).toBe('y')
    })

    it('removes Gemma channel tags but preserves <think>', () => {
      const input = '<think>a</think> <|channel|>thought extra'
      const out = stripNonCanonicalTags(input)
      expect(out).toContain('<think>a</think>')
      expect(out).not.toContain('<|channel|>')
    })
  })

  describe('finalStripThinkingTags — end-of-stream safety', () => {
    it('removes everything including canonical <think> by default', () => {
      const input = '<think>x</think><thought>y</thought>answer'
      expect(finalStripThinkingTags(input)).toBe('answer')
    })

    it('keeps canonical <think> when keepCanonicalThink=true', () => {
      const input = '<think>x</think><thought>y</thought>answer'
      const out = finalStripThinkingTags(input, true)
      expect(out).toContain('<think>x</think>')
      expect(out).not.toContain('<thought>')
      expect(out).toContain('answer')
    })

    it('removes orphan </think> closer', () => {
      expect(finalStripThinkingTags('middle</think>tail')).toBe('middletail')
    })

    it('removes orphan <think> opener', () => {
      expect(finalStripThinkingTags('head<think>tail')).toBe('headtail')
    })

    it('trims the final result', () => {
      expect(finalStripThinkingTags('  answer  ')).toBe('answer')
      expect(finalStripThinkingTags('<thought>a</thought>\n  answer  \n')).toBe(
        'answer'
      )
    })

    it('pure-answer content passes through (trimmed)', () => {
      expect(finalStripThinkingTags('Hello world')).toBe('Hello world')
    })
  })

  describe('edge cases / regression guards', () => {
    it('does not eat content that merely contains the word "thought"', () => {
      // False-positive guard: we match <thought> as a TAG, not the word.
      const input = 'I thought about it.'
      expect(stripAllThinkingTags(input)).toBe('I thought about it.')
    })

    it('handles nested markup gracefully (simple non-greedy match)', () => {
      // A <thought> inside HTML content shouldn't over-match across a later
      // unrelated </thought>. The non-greedy regex limits the span to the
      // next close tag.
      const input =
        '<thought>a</thought>between<thought>b</thought>after'
      expect(stripAllThinkingTags(input)).toBe('betweenafter')
    })

    it('stripping is idempotent (applying twice yields same result)', () => {
      const input = '<thought>a</thought>clean<reasoning>b</reasoning>'
      const once = stripAllThinkingTags(input)
      const twice = stripAllThinkingTags(once)
      expect(twice).toBe(once)
    })

    it('typical Gemma 4 streaming snapshot (mid-generation)', () => {
      const streamSnap =
        'Sure! <|channel|>thought\nLet me plan:\n1. parse input\n2.'
      const out = stripAllThinkingTags(streamSnap)
      expect(out).not.toContain('channel')
      expect(out).toContain('Sure!')
    })
  })
})
