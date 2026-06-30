/**
 * Regression: when multiple local backends are detected on startup the user
 * used to see the BackendSelector modal without anything being pre-enabled.
 * If they skipped or dismissed the modal, LM Studio / vLLM / etc. stayed
 * disabled and their models never appeared in the chat model dropdown.
 *
 * Reported on Discord #help-chat (2026-04-21, user djoks.exe, "LU does not
 * recognize the models"). Fix: always pre-enable the first non-Ollama
 * openai-compat backend that was detected, even when multiple are running.
 * The selector modal is kept as an educational picker so the user can still
 * change which one is primary.
 *
 * This test checks the source of AppShell.tsx for the fix pattern — we're
 * not mounting the full component, just guarding against a regression where
 * the 2+ branch silently does nothing.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'fs'
import { fileURLToPath } from 'url'
import { dirname, join } from 'path'

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)
const src = readFileSync(join(__dirname, '../AppShell.tsx'), 'utf8')

describe('AppShell multi-backend auto-enable', () => {
  it('finds a non-Ollama backend before enabling', () => {
    // We look for the pattern introduced by the fix: a find() that excludes
    // ollama and pre-enables the first matching backend.
    expect(src).toMatch(/backends\.find\(.*b\.id\s*!==\s*['"]ollama['"]/)
  })

  it('calls setProviderConfig for the detected non-Ollama backend', () => {
    // The enablement must happen through the provider store and must flag
    // the backend as local (so the provider UI treats it correctly).
    expect(src).toContain("setProviderConfig('openai',")
    expect(src).toContain('enabled: true')
    expect(src).toContain('isLocal: true')
  })

  it('still shows the selector modal when more than one backend is detected', () => {
    // After the fix, the selector must remain for the 2+ case as a way to
    // change the picked primary. This guards against accidentally deleting
    // the selector along with the auto-enable.
    expect(src).toContain('setDetectedBackends(backends)')
    expect(src).toContain('setShowSelector(true)')
  })

  it('early-returns on the single-backend path after pre-enabling', () => {
    // Single backend + already auto-enabled above → return before showing the
    // selector (which would look weird with one option).
    expect(src).toMatch(/if \(backends\.length === 1\) return/)
  })

  it('leaves the zero-backends early-return intact', () => {
    // If detection finds nothing, we still bail early. Guards against the
    // refactor accidentally trying to auto-enable with an empty list.
    expect(src).toContain('if (backends.length === 0) return')
  })

  // v2.3.9 — Discord-reported: "popup comes back every 5-10 seconds".
  // The sessionStorage guard was not enough in some conditions (WebView2 reload
  // via the backup-restore triad, browser cache eviction, etc). We now also
  // gate on a persisted flag so existing users who clicked "Don't show again"
  // stop seeing the modal for good.
  it('persistently gates the selector on hideBackendSelector', () => {
    // The guard must live inside the multi-backend branch (i.e. after the
    // length === 1 early-return) so single-backend users still see nothing.
    expect(src).toMatch(/hideBackendSelector/)
    expect(src).toMatch(/if \(useProviderStore\.getState\(\)\.hideBackendSelector\) return/)
  })
})
