import { describe, it, expect } from 'vitest'
import { civitaiHostSwap, CIVITAI_DEFAULT_HOST } from '../discover'

// GitHub #53 — civitai.red mirror support. The CivitAI API hands back absolute
// civitai.com download URLs even when queried through a mirror, so the host has
// to be rewritten or the actual file download still hits the blocked origin.
describe('civitaiHostSwap (#53 mirror download URLs)', () => {
  it('is a no-op on the default host', () => {
    const u = 'https://civitai.com/api/download/models/12345'
    expect(civitaiHostSwap(u, CIVITAI_DEFAULT_HOST)).toBe(u)
  })

  it('rewrites the host to the mirror', () => {
    expect(civitaiHostSwap('https://civitai.com/api/download/models/12345', 'civitai.red'))
      .toBe('https://civitai.red/api/download/models/12345')
  })

  it('keeps the path, query and token intact', () => {
    expect(civitaiHostSwap('https://civitai.com/api/download/models/9?type=Model&token=abc', 'civitai.red'))
      .toBe('https://civitai.red/api/download/models/9?type=Model&token=abc')
  })

  it('only rewrites the civitai.com origin, not the path', () => {
    // A stray "civitai.com" later in the URL must not be touched.
    expect(civitaiHostSwap('https://civitai.com/x/civitai.com/y', 'civitai.red'))
      .toBe('https://civitai.red/x/civitai.com/y')
  })

  it('leaves non-civitai and undefined URLs alone', () => {
    expect(civitaiHostSwap(undefined, 'civitai.red')).toBeUndefined()
    expect(civitaiHostSwap('https://huggingface.co/x.safetensors', 'civitai.red'))
      .toBe('https://huggingface.co/x.safetensors')
  })

  it('treats an empty host as the default (no swap)', () => {
    const u = 'https://civitai.com/api/download/models/1'
    expect(civitaiHostSwap(u, '')).toBe(u)
  })
})
