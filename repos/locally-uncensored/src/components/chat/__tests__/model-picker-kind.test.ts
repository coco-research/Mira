/**
 * pickKindForToolCall — the ToolCallBlock-side classification must mirror
 * the executor gate (image vs video-t2v vs video-i2v incl. aliases), or the
 * picker card would attach to the wrong tool call.
 *
 * Run: npx vitest run src/components/chat/__tests__/model-picker-kind.test.ts
 */
import { describe, it, expect } from 'vitest'
import { pickKindForToolCall, PICK_PREF_KEY } from '../ModelPickerCard'

const tc = (toolName: string, args: Record<string, unknown> = {}) => ({ toolName, args }) as never

describe('pickKindForToolCall', () => {
  it('image_generate → image', () => {
    expect(pickKindForToolCall(tc('image_generate'))).toBe('image')
  })

  it('video_generate without input image → video-t2v', () => {
    expect(pickKindForToolCall(tc('video_generate', { prompt: 'waves' }))).toBe('video-t2v')
  })

  it('video_generate with inputImage → video-i2v (flat, snake_case, image, nested settings)', () => {
    expect(pickKindForToolCall(tc('video_generate', { inputImage: 'a.png' }))).toBe('video-i2v')
    expect(pickKindForToolCall(tc('video_generate', { input_image: 'a.png' }))).toBe('video-i2v')
    expect(pickKindForToolCall(tc('video_generate', { image: 'a.png' }))).toBe('video-i2v')
    expect(pickKindForToolCall(tc('video_generate', { settings: { inputImage: 'a.png' } }))).toBe('video-i2v')
  })

  it('non-generation tools → null', () => {
    expect(pickKindForToolCall(tc('file_read', { path: 'x' }))).toBeNull()
    expect(pickKindForToolCall(tc('web_search', { query: 'x' }))).toBeNull()
  })

  it('pref keys map 1:1 to the settings fields', () => {
    expect(PICK_PREF_KEY.image).toBe('preferredImageModel')
    expect(PICK_PREF_KEY['video-t2v']).toBe('preferredVideoT2VModel')
    expect(PICK_PREF_KEY['video-i2v']).toBe('preferredVideoI2VModel')
  })
})
