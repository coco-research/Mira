/**
 * ToolCallBlock inline-media tests
 *   - F1 (konata3602 commitment 2026-05-23): render generated pictures inline.
 *   - Render fix (konata3602 bug 2026-06-07): the old localhost-only regex
 *     silently failed on the /comfyui/view proxy path (web/dev build) and on a
 *     custom ComfyUI host, so the user saw the raw "/comfyui/view?…" text and
 *     NO image. comfyViewUrlFromResult() now accepts the proxy path, loopback
 *     hosts, and the user-configured comfy host — while still NOT auto-loading
 *     arbitrary third-party URLs from tool output (CSP + privacy).
 *
 * Run: npx vitest run src/components/chat/__tests__/ToolCallBlock-image.test.ts
 */
import { describe, it, expect, afterEach } from 'vitest'
import { comfyViewUrlFromResult, isInlineVideoUrl, comfyViewParams } from '../ToolCallBlock'
import { setComfyHost, getComfyHost } from '../../../api/backend'

describe('comfyViewUrlFromResult', () => {
  describe('positive cases (our own ComfyUI output)', () => {
    it('returns a localhost /view URL', () => {
      const url = 'http://localhost:8188/view?filename=foo.png&subfolder=&type=output&t=123'
      expect(comfyViewUrlFromResult(url)).toBe(url)
    })

    it('returns a 127.0.0.1 /view URL', () => {
      const url = 'http://127.0.0.1:8188/view?filename=x.png&subfolder=&type=output&t=456'
      expect(comfyViewUrlFromResult(url)).toBe(url)
    })

    // The exact bug konata hit: the web build talks to ComfyUI through the
    // Vite "/comfyui" proxy, so the result URL is RELATIVE. The old regex
    // (http://localhost only) never matched it → no image.
    it('returns the /comfyui/view proxy path (konata regression)', () => {
      const url = '/comfyui/view?filename=locally_uncensored_00018_.png&subfolder=&type=output'
      expect(comfyViewUrlFromResult(url)).toBe(url)
    })

    it('returns a bare /view proxy path', () => {
      const url = '/view?filename=foo.png&subfolder=&type=output'
      expect(comfyViewUrlFromResult(url)).toBe(url)
    })
  })

  describe('negative cases (must NOT auto-load)', () => {
    it('returns null for a third-party https image URL', () => {
      expect(comfyViewUrlFromResult('https://example.com/image.png')).toBeNull()
    })

    it('returns null for a non-local /view host (privacy)', () => {
      // Has /view + filename but points at someone else's box — never auto-load.
      expect(comfyViewUrlFromResult('http://evil.example.com:8188/view?filename=a.png')).toBeNull()
    })

    it('returns null for a localhost URL that is not /view', () => {
      expect(comfyViewUrlFromResult('http://localhost:8188/api/history/abc')).toBeNull()
    })

    it('returns null for a /view URL with no filename', () => {
      expect(comfyViewUrlFromResult('http://localhost:8188/view?subfolder=&type=output')).toBeNull()
    })

    it('returns null for empty / missing result', () => {
      expect(comfyViewUrlFromResult('')).toBeNull()
      expect(comfyViewUrlFromResult(null)).toBeNull()
      expect(comfyViewUrlFromResult(undefined)).toBeNull()
    })
  })

  describe('custom / remote ComfyUI host', () => {
    afterEach(() => setComfyHost('localhost'))

    it('returns a /view URL on the user-configured comfy host', () => {
      setComfyHost('192.168.1.50')
      expect(getComfyHost()).toBe('192.168.1.50')
      const url = 'http://192.168.1.50:8188/view?filename=foo.png&subfolder=&type=output'
      expect(comfyViewUrlFromResult(url)).toBe(url)
    })

    it('still rejects a different host even when a custom host is set', () => {
      setComfyHost('192.168.1.50')
      expect(comfyViewUrlFromResult('http://10.0.0.9:8188/view?filename=foo.png&type=output')).toBeNull()
    })
  })

  describe('integration with executeImageGenerate() / pollAndExtract output', () => {
    // Desktop (Tauri) shape — vram-handoff pollAndExtract:
    //   `Image generated: <file> (prompt: "...")\n<absolute /view URL>`
    it('extracts the absolute URL from the full desktop result string', () => {
      const result =
        'Image generated: foo.png (prompt: "test")\n' +
        'http://localhost:8188/view?filename=foo.png&subfolder=&type=output&t=123'
      expect(comfyViewUrlFromResult(result)).toBe(
        'http://localhost:8188/view?filename=foo.png&subfolder=&type=output&t=123',
      )
    })

    // Web/dev (Vite proxy) shape — exactly what konata pasted on Discord.
    it('extracts the relative proxy URL from the konata result string', () => {
      const result =
        'Image generated: locally_uncensored_00018_.png (prompt: "...")\n' +
        '/comfyui/view?filename=locally_uncensored_00018_.png&subfolder=&type=output'
      expect(comfyViewUrlFromResult(result)).toBe(
        '/comfyui/view?filename=locally_uncensored_00018_.png&subfolder=&type=output',
      )
    })
  })
})

// Feature EE (v2.5.0): video_generate outputs render in <video>, images in
// <img>. isInlineVideoUrl inspects the `filename=` query param of the /view URL
// (NOT the URL tail, which ends in `&t=…`).
describe('isInlineVideoUrl', () => {
  it('detects .mp4 outputs from the filename query param', () => {
    expect(isInlineVideoUrl('http://localhost:8188/view?filename=clip.mp4&subfolder=&type=output&t=9')).toBe(true)
  })
  it('detects .webm outputs', () => {
    expect(isInlineVideoUrl('http://localhost:8188/view?filename=clip.webm&subfolder=&type=output&t=9')).toBe(true)
  })
  it('treats .png as NOT video (renders as <img>)', () => {
    expect(isInlineVideoUrl('http://localhost:8188/view?filename=foo.png&subfolder=&type=output&t=9')).toBe(false)
  })
  it('treats animated .webp as NOT video (animates fine in <img>)', () => {
    // SaveAnimatedWEBP output — must stay on the <img> path per spec.
    expect(isInlineVideoUrl('http://localhost:8188/view?filename=locally_uncensored_vid.webp&subfolder=&type=output&t=9')).toBe(false)
  })
  it('does not misfire on a .mp4 substring elsewhere in the query', () => {
    // The video check keys off the filename param, not a stray ".mp4" token.
    expect(isInlineVideoUrl('http://localhost:8188/view?filename=foo.png&subfolder=a.mp4dir&type=output')).toBe(false)
  })
  it('detects a .mp4 on the relative /comfyui/view proxy path', () => {
    expect(isInlineVideoUrl('/comfyui/view?filename=clip.mp4&subfolder=&type=output')).toBe(true)
  })
})

// David 2026-06-12: the inline image/video gets a Download button that pulls the
// ComfyUI filename/subfolder/type back out of the /view URL.
describe('comfyViewParams', () => {
  it('parses an absolute /view URL (drops the cache-buster)', () => {
    expect(comfyViewParams('http://localhost:8188/view?filename=apple.png&subfolder=&type=output&t=123'))
      .toEqual({ filename: 'apple.png', subfolder: '', type: 'output' })
  })

  it('keeps a non-empty subfolder', () => {
    expect(comfyViewParams('http://localhost:8188/view?filename=clip.mp4&subfolder=vids&type=output'))
      .toEqual({ filename: 'clip.mp4', subfolder: 'vids', type: 'output' })
  })

  it('parses the relative /comfyui/view proxy path and defaults type to output', () => {
    expect(comfyViewParams('/comfyui/view?filename=foo.webp&subfolder='))
      .toEqual({ filename: 'foo.webp', subfolder: '', type: 'output' })
  })

  it('returns null without a filename or url', () => {
    expect(comfyViewParams('http://localhost:8188/view?subfolder=&type=output')).toBeNull()
    expect(comfyViewParams(null)).toBeNull()
    expect(comfyViewParams('')).toBeNull()
  })
})
