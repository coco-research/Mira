/**
 * Prompt-derived output filenames (David 2026-06-11): images/videos should be
 * named after what was asked ("red_apple_on_white_plate_00001_.png"), not the
 * opaque "locally_uncensored_00123_.png", so the result string is self-
 * descriptive and a follow-up "animate the red-apple image" can pass the name
 * straight back.
 *
 * Run: npx vitest run src/api/__tests__/prompt-filename-prefix.test.ts
 */
import { describe, it, expect } from 'vitest'
import { promptFilenamePrefix } from '../dynamic-workflow'

describe('promptFilenamePrefix', () => {
  it('slugifies the first words of an image prompt', () => {
    expect(promptFilenamePrefix('a red apple on a white plate', false)).toBe('a_red_apple_on_a_white')
  })

  it('video prompts get a __vid tag so they never collide with the still', () => {
    expect(promptFilenamePrefix('ocean waves at sunset', true)).toBe('ocean_waves_at_sunset__vid')
  })

  it('caps length and word count, trims trailing underscores', () => {
    const r = promptFilenamePrefix('supercalifragilisticexpialidocious antidisestablishmentarianism pneumonoultramicroscopicsilicovolcanoconiosis', false)
    expect(r.length).toBeLessThanOrEqual(48)
    expect(r.endsWith('_')).toBe(false)
  })

  it('strips punctuation and collapses separators', () => {
    expect(promptFilenamePrefix('A cat, sitting!! on—a couch.', false)).toBe('a_cat_sitting_on_a_couch')
  })

  it('empty / whitespace / emoji-only prompt falls back to the legacy prefix', () => {
    expect(promptFilenamePrefix('', false)).toBe('locally_uncensored')
    expect(promptFilenamePrefix('   ', true)).toBe('locally_uncensored_vid')
    expect(promptFilenamePrefix('🎨🎬', false)).toBe('locally_uncensored')
    expect(promptFilenamePrefix(undefined, false)).toBe('locally_uncensored')
  })

  it('non-ASCII words degrade gracefully (umlauts dropped, ASCII kept)', () => {
    // "Über den Wolken" → ber_den_wolken (the Ü is non-[a-z0-9]).
    expect(promptFilenamePrefix('Über den Wolken', false)).toBe('ber_den_wolken')
  })

  it('result is always a safe filename fragment (no path separators or spaces)', () => {
    for (const p of ['a/b\\c', 'foo bar', 'x:y*z?', 'normal prompt']) {
      const r = promptFilenamePrefix(p, false)
      expect(r).toMatch(/^[a-z0-9_]+$/)
    }
  })
})
