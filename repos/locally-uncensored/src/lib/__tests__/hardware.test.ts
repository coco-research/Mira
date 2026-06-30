import { describe, it, expect } from 'vitest'
import { meetsImageGenThreshold } from '../hardware'

// ═══════════════════════════════════════════════════════════════
//  hardware — image-gen capability threshold (VRAM≥12 OR RAM≥16)
// ═══════════════════════════════════════════════════════════════

describe('meetsImageGenThreshold', () => {
  it('passes on enough VRAM alone', () => {
    expect(meetsImageGenThreshold(12, 8)).toBe(true)   // 12GB VRAM, 8GB RAM
    expect(meetsImageGenThreshold(24, 8)).toBe(true)
  })

  it('passes on enough RAM alone', () => {
    expect(meetsImageGenThreshold(0, 16)).toBe(true)   // no GPU, 16GB RAM
    expect(meetsImageGenThreshold(6, 32)).toBe(true)
  })

  it('fails when below both thresholds', () => {
    expect(meetsImageGenThreshold(8, 8)).toBe(false)
    expect(meetsImageGenThreshold(11.9, 15.9)).toBe(false)
    expect(meetsImageGenThreshold(0, 0)).toBe(false)
  })

  it('treats the thresholds as inclusive (≥)', () => {
    expect(meetsImageGenThreshold(12, 0)).toBe(true)
    expect(meetsImageGenThreshold(0, 16)).toBe(true)
  })
})
