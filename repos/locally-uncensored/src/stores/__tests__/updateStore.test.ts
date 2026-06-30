import { describe, it, expect, vi, beforeEach } from 'vitest'

// Mock dependencies before importing the store
vi.mock('../../api/backend', () => ({
  isTauri: () => false, // tests run in dev mode (GitHub API path)
  openExternal: vi.fn(),
}))

// Mock package.json version
vi.mock('../../../package.json', () => ({
  version: '2.0.0',
}))

import { useUpdateStore, isNewerVersion } from '../updateStore'

// ── Helper to build a GitHub API response ─────────────────────

function makeGitHubRelease(tagName: string, opts: {
  body?: string
  assets?: { name: string; browser_download_url: string }[]
} = {}) {
  return {
    tag_name: tagName,
    html_url: `https://github.com/purpledoubled/locally-uncensored/releases/tag/${tagName}`,
    body: opts.body ?? 'Release notes here',
    assets: opts.assets ?? [],
  }
}

// ═══════════════════════════════════════════════════════════════
//  updateStore
// ═══════════════════════════════════════════════════════════════

describe('updateStore', () => {
  beforeEach(() => {
    useUpdateStore.setState({
      currentVersion: '2.0.0',
      latestVersion: null,
      updateAvailable: false,
      releaseNotes: null,
      isChecking: false,
      lastChecked: null,
      dismissed: null,
      downloadStatus: 'idle',
      downloadProgress: 0,
      downloadedBytes: 0,
      totalBytes: 0,
      errorMessage: null,
    })
    vi.restoreAllMocks()
  })

  // ── isNewerVersion (exported, direct tests) ─────────────────

  describe('isNewerVersion', () => {
    it('detects newer major: 3.0.0 > 2.0.0', () => {
      expect(isNewerVersion('3.0.0', '2.0.0')).toBe(true)
    })

    it('detects newer minor: 2.1.0 > 2.0.0', () => {
      expect(isNewerVersion('2.1.0', '2.0.0')).toBe(true)
    })

    it('detects newer patch: 2.0.1 > 2.0.0', () => {
      expect(isNewerVersion('2.0.1', '2.0.0')).toBe(true)
    })

    it('same version = false', () => {
      expect(isNewerVersion('2.0.0', '2.0.0')).toBe(false)
    })

    it('older version = false', () => {
      expect(isNewerVersion('1.9.9', '2.0.0')).toBe(false)
    })

    it('strips v prefix', () => {
      expect(isNewerVersion('v3.0.0', 'v2.0.0')).toBe(true)
    })

    it('handles missing patch', () => {
      expect(isNewerVersion('3.0', '2.0.0')).toBe(true)
    })

    it('handles minor rollover: 1.1.0 < 2.0.0', () => {
      expect(isNewerVersion('1.1.0', '2.0.0')).toBe(false)
    })

    // ── diimmortalis regression case (Discord, 2026-04-25) ────
    // The reported display was `Current Version: 2.4.1 | Latest Version: 2.3.8`
    // because a stale persisted snapshot survived an out-of-band binary
    // upgrade. The helper itself was always correct — these assertions pin
    // that behavior so future reshuffles can't reintroduce the inversion.
    it('persisted 2.3.8 is NOT newer than current 2.4.1 (diimmortalis case)', () => {
      expect(isNewerVersion('2.3.8', '2.4.1')).toBe(false)
      expect(isNewerVersion('v2.3.8', 'v2.4.1')).toBe(false)
    })

    it('2.4.1 is newer than 2.3.8 (sanity invert of diimmortalis case)', () => {
      expect(isNewerVersion('2.4.1', '2.3.8')).toBe(true)
    })
  })

  // ── checkForUpdate (dev mode — GitHub API) ──────────────────

  describe('checkForUpdate', () => {
    it('detects newer version via GitHub API', async () => {
      vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce({
        ok: true,
        json: async () => makeGitHubRelease('v3.0.0'),
      } as Response)

      await useUpdateStore.getState().checkForUpdate()
      expect(useUpdateStore.getState().updateAvailable).toBe(true)
      expect(useUpdateStore.getState().latestVersion).toBe('3.0.0')
    })

    it('same version = not available', async () => {
      vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce({
        ok: true,
        json: async () => makeGitHubRelease('v2.0.0'),
      } as Response)

      await useUpdateStore.getState().checkForUpdate()
      expect(useUpdateStore.getState().updateAvailable).toBe(false)
    })

    it('stores release notes', async () => {
      vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce({
        ok: true,
        json: async () => makeGitHubRelease('v3.0.0', { body: 'Bug fixes' }),
      } as Response)

      await useUpdateStore.getState().checkForUpdate()
      expect(useUpdateStore.getState().releaseNotes).toBe('Bug fixes')
    })

    it('sets releaseNotes to null when body is empty', async () => {
      vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce({
        ok: true,
        json: async () => makeGitHubRelease('v3.0.0', { body: '' }),
      } as Response)

      await useUpdateStore.getState().checkForUpdate()
      expect(useUpdateStore.getState().releaseNotes).toBeNull()
    })

    it('sets lastChecked timestamp', async () => {
      const before = Date.now()
      vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce({
        ok: true,
        json: async () => makeGitHubRelease('v3.0.0'),
      } as Response)

      await useUpdateStore.getState().checkForUpdate()
      expect(useUpdateStore.getState().lastChecked).toBeGreaterThanOrEqual(before)
    })

    it('skips check if checked recently', async () => {
      const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue({
        ok: true,
        json: async () => makeGitHubRelease('v3.0.0'),
      } as Response)

      await useUpdateStore.getState().checkForUpdate()
      expect(fetchSpy).toHaveBeenCalledTimes(1)

      // Second call within interval is skipped
      await useUpdateStore.getState().checkForUpdate()
      expect(fetchSpy).toHaveBeenCalledTimes(1)
    })

    it('handles non-ok response gracefully', async () => {
      vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce({
        ok: false,
        status: 403,
      } as Response)

      await useUpdateStore.getState().checkForUpdate()
      expect(useUpdateStore.getState().isChecking).toBe(false)
      expect(useUpdateStore.getState().updateAvailable).toBe(false)
    })

    it('handles fetch error gracefully (offline)', async () => {
      vi.spyOn(globalThis, 'fetch').mockRejectedValueOnce(new Error('Network error'))

      await useUpdateStore.getState().checkForUpdate()
      expect(useUpdateStore.getState().isChecking).toBe(false)
      expect(useUpdateStore.getState().lastChecked).not.toBeNull()
    })

    it('does not run concurrently (isChecking guard)', async () => {
      let resolveFirst: (v: Response) => void
      const firstPromise = new Promise<Response>(r => { resolveFirst = r })
      const fetchSpy = vi.spyOn(globalThis, 'fetch').mockReturnValueOnce(firstPromise as Promise<Response>)

      const p1 = useUpdateStore.getState().checkForUpdate()
      expect(useUpdateStore.getState().isChecking).toBe(true)

      const p2 = useUpdateStore.getState().checkForUpdate()

      resolveFirst!({
        ok: true,
        json: async () => makeGitHubRelease('v3.0.0'),
      } as Response)

      await Promise.all([p1, p2])
      expect(fetchSpy).toHaveBeenCalledTimes(1)
    })
  })

  // ── truncateNotes (tested indirectly) ──────────────────────

  describe('release notes truncation', () => {
    it('truncates notes longer than 300 chars', async () => {
      const longNotes = Array.from({ length: 5 }, (_, i) => `Line ${i}: ${'x'.repeat(80)}`).join('\n')
      vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce({
        ok: true,
        json: async () => makeGitHubRelease('v3.0.0', { body: longNotes }),
      } as Response)

      await useUpdateStore.getState().checkForUpdate()
      const notes = useUpdateStore.getState().releaseNotes!
      expect(notes.length).toBeLessThanOrEqual(303)
      expect(notes).toContain('...')
    })

    it('keeps short notes intact', async () => {
      vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce({
        ok: true,
        json: async () => makeGitHubRelease('v3.0.0', { body: 'Short note' }),
      } as Response)

      await useUpdateStore.getState().checkForUpdate()
      expect(useUpdateStore.getState().releaseNotes).toBe('Short note')
    })

    it('filters blank lines from notes', async () => {
      vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce({
        ok: true,
        json: async () => makeGitHubRelease('v3.0.0', { body: 'Line1\n\n\nLine2\n\nLine3' }),
      } as Response)

      await useUpdateStore.getState().checkForUpdate()
      expect(useUpdateStore.getState().releaseNotes).toBe('Line1\nLine2\nLine3')
    })
  })

  // ── download state ────────────────────────────────────────

  describe('download state', () => {
    it('initial downloadStatus is idle', () => {
      expect(useUpdateStore.getState().downloadStatus).toBe('idle')
    })

    it('downloadUpdate is no-op without pending update (dev mode)', async () => {
      await useUpdateStore.getState().downloadUpdate()
      expect(useUpdateStore.getState().downloadStatus).toBe('idle')
    })

    it('installAndRestart is no-op without pending update', async () => {
      await useUpdateStore.getState().installAndRestart()
      expect(useUpdateStore.getState().downloadStatus).toBe('idle')
    })
  })

  // ── dismissUpdate / clearDismiss ───────────────────────────

  describe('dismissUpdate', () => {
    it('stores the latest version as dismissed', () => {
      useUpdateStore.setState({ latestVersion: '3.0.0' })
      useUpdateStore.getState().dismissUpdate()
      expect(useUpdateStore.getState().dismissed).toBe('3.0.0')
    })

    it('stores null if no latestVersion', () => {
      useUpdateStore.getState().dismissUpdate()
      expect(useUpdateStore.getState().dismissed).toBeNull()
    })
  })

  describe('clearDismiss', () => {
    it('clears the dismissed version', () => {
      useUpdateStore.setState({ dismissed: '3.0.0' })
      useUpdateStore.getState().clearDismiss()
      expect(useUpdateStore.getState().dismissed).toBeNull()
    })

    it('is idempotent when already null', () => {
      useUpdateStore.getState().clearDismiss()
      expect(useUpdateStore.getState().dismissed).toBeNull()
    })
  })
})
