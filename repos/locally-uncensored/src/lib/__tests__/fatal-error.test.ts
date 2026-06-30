/**
 * Bug D (surfingbird1010) — boot-failure recovery (fatal-error.ts).
 *
 * Critical safety properties (env: node — no DOM): a "Reset settings" recovery
 * must clear app settings but NEVER user DATA (chats, knowledge, curated
 * memory), and the error text shown in the recovery screen must be escaped (no
 * HTML injection). The DOM render itself is verified live (app launch) — here we
 * lock the data-safety + escaping logic.
 *
 * Run: npx vitest run src/lib/__tests__/fatal-error.test.ts
 */
import { describe, it, expect } from 'vitest'
import { SETTINGS_STORAGE_KEYS, escapeHtml } from '../fatal-error'

describe('SETTINGS_STORAGE_KEYS (Bug D reset safety)', () => {
  it('includes the settings/state stores', () => {
    for (const k of ['chat-settings', 'lu-providers', 'locally-uncensored-voice'])
      expect(SETTINGS_STORAGE_KEYS).toContain(k)
  })

  it('NEVER includes user-DATA stores (chats / knowledge / memory)', () => {
    for (const dataKey of ['chat-conversations', 'rag-store', 'locally-uncensored-memory']) {
      expect(SETTINGS_STORAGE_KEYS).not.toContain(dataKey)
    }
  })
})

describe('escapeHtml (Bug D recovery-screen XSS safety)', () => {
  it('escapes angle brackets, quotes and ampersands', () => {
    expect(escapeHtml('<img src=x onerror=alert(1)>')).toBe(
      '&lt;img src=x onerror=alert(1)&gt;',
    )
    expect(escapeHtml(`a & "b" 'c'`)).toBe('a &amp; &quot;b&quot; &#39;c&#39;')
  })

  it('leaves plain text unchanged', () => {
    expect(escapeHtml('hydration boom: cannot read x of undefined')).toBe(
      'hydration boom: cannot read x of undefined',
    )
  })
})
