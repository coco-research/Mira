import { describe, it, expect } from 'vitest'
import { SETTINGS_TAB_RESET_KEYS } from '../settings-reset'
import { DEFAULT_SETTINGS } from '../constants'
import { useVoiceStore } from '../../stores/voiceStore'

// GitHub #59 — per-tab reset scope. These tests pin the contract: every key
// in the map is a real Settings key, no key is double-owned by two tabs, and
// the lifecycle marker onboardingDone is never part of a section reset.
describe('SETTINGS_TAB_RESET_KEYS (#59)', () => {
  const allKeys = Object.values(SETTINGS_TAB_RESET_KEYS).flat()

  it('every mapped key exists in DEFAULT_SETTINGS', () => {
    for (const k of allKeys) {
      expect(Object.prototype.hasOwnProperty.call(DEFAULT_SETTINGS, k), `unknown settings key: ${String(k)}`).toBe(true)
    }
  })

  it('no key is owned by two tabs', () => {
    const seen = new Set<string>()
    for (const k of allKeys) {
      expect(seen.has(String(k)), `key mapped twice: ${String(k)}`).toBe(false)
      seen.add(String(k))
    }
  })

  it('never includes onboardingDone (lifecycle marker, not a preference)', () => {
    expect(allKeys.includes('onboardingDone')).toBe(false)
  })

  it('general tab covers the visible General sections (appearance, generation, hardware, timeouts)', () => {
    const g = SETTINGS_TAB_RESET_KEYS.general
    for (const k of ['theme', 'temperature', 'topP', 'topK', 'maxTokens', 'contextWindowOverride', 'gpuVendor', 'gpuIndices', 'imageGenTimeoutMinutes', 'videoGenTimeoutMinutes'] as const) {
      expect(g, `general tab missing ${k}`).toContain(k)
    }
  })

  it('agent tab covers codex + search-provider + budget keys', () => {
    const a = SETTINGS_TAB_RESET_KEYS.agent
    for (const k of ['searchProvider', 'braveApiKey', 'tavilyApiKey', 'codexStageMode', 'codexReviewMode', 'agentMaxToolCalls', 'agentMaxIterations'] as const) {
      expect(a, `agent tab missing ${k}`).toContain(k)
    }
  })
})

describe('voiceStore.resetVoiceDefaults (#59)', () => {
  it('restores persisted voice settings and leaves availability probes alone', () => {
    useVoiceStore.setState({
      sttEnabled: true,
      ttsEnabled: true,
      piperVoice: 'en_GB-alba-medium',
      ttsVoice: 'Microsoft Zira',
      ttsRate: 1.6,
      ttsPitch: 0.4,
      sttAvailable: true,
      ttsAvailable: true,
    })
    useVoiceStore.getState().resetVoiceDefaults()
    const s = useVoiceStore.getState()
    expect(s.sttEnabled).toBe(false)
    expect(s.ttsEnabled).toBe(false)
    expect(s.piperVoice).toBe('en_US-lessac-medium')
    expect(s.ttsVoice).toBe('')
    expect(s.ttsRate).toBe(1.0)
    expect(s.ttsPitch).toBe(1.0)
    // Probe state reflects what's installed on disk — reset must not lie about it.
    expect(s.sttAvailable).toBe(true)
    expect(s.ttsAvailable).toBe(true)
  })
})
