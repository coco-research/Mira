import { describe, it, expect, vi, beforeEach } from 'vitest'

const backendCall = vi.fn()

vi.mock('../../backend', () => ({
  backendCall: (...args: unknown[]) => backendCall(...args),
}))

import { fetchRepoMap, renderRepoMapSection, type RepoMapResult } from '../repo-map'

beforeEach(() => {
  backendCall.mockReset()
})

describe('fetchRepoMap', () => {
  it('returns an empty map when no working directory is given', async () => {
    const result = await fetchRepoMap({ workingDirectory: '' })
    expect(result).toEqual({ files: [], count: 0 })
    expect(backendCall).not.toHaveBeenCalled()
  })

  it('calls the bridge repo_map command with the working dir, query and limit', async () => {
    backendCall.mockResolvedValueOnce({
      files: [{ path: 'a.ts', score: 0.5, snippet: '// a' }],
      count: 1,
    })
    await fetchRepoMap({
      workingDirectory: '/Users/me/repo',
      query: 'auth',
      limit: 50,
    })
    expect(backendCall).toHaveBeenCalledOnce()
    // Payload MUST be wrapped in `{ args: … }` — the Rust `repo_map` command
    // takes a single `args: Value` param. A flat payload is rejected at the
    // bridge ("missing required key args"). Regression guard for the 2026-06-02
    // fix that revived codexRepoMapEnabled.
    expect(backendCall.mock.calls[0]).toEqual([
      'repo_map',
      { args: { workingDirectory: '/Users/me/repo', query: 'auth', limit: 50 } },
    ])
  })

  it('defaults the limit to 20 when caller omits it', async () => {
    backendCall.mockResolvedValueOnce({ files: [], count: 0 })
    await fetchRepoMap({ workingDirectory: '/r' })
    const payload = backendCall.mock.calls[0][1] as { args: Record<string, unknown> }
    expect(payload.args.limit).toBe(20)
  })

  it('coerces a non-array files field into an empty array', async () => {
    backendCall.mockResolvedValueOnce({ files: null, count: 0 } as unknown)
    const result = await fetchRepoMap({ workingDirectory: '/r' })
    expect(result.files).toEqual([])
  })
})

describe('renderRepoMapSection', () => {
  function map(files: number): RepoMapResult {
    return {
      count: files,
      files: Array.from({ length: files }, (_, i) => ({
        path: `src/f${i}.ts`,
        score: 1 / (i + 1),
        snippet: `// file ${i}`,
      })),
    }
  }

  it('returns empty string for an empty map (no header without content)', () => {
    expect(renderRepoMapSection({ files: [], count: 0 })).toBe('')
  })

  it('renders a header + one bullet per file', () => {
    const out = renderRepoMapSection(map(2))
    expect(out).toMatch(/REPO MAP/)
    expect(out).toMatch(/- src\/f0\.ts/)
    expect(out).toMatch(/- src\/f1\.ts/)
  })

  it('respects maxChars by truncating later entries', () => {
    const out = renderRepoMapSection(map(200), { maxChars: 250 })
    // Header itself is ~150 chars; only a couple of bullets should survive.
    const bullets = out.split('\n').filter((l) => l.startsWith('- ')).length
    expect(bullets).toBeGreaterThan(0)
    expect(bullets).toBeLessThan(10)
    expect(out.length).toBeLessThanOrEqual(260)
  })

  it('omits the snippet trailer when the file has no snippet', () => {
    const out = renderRepoMapSection({
      count: 1,
      files: [{ path: 'src/x.ts', score: 0.1, snippet: '' }],
    })
    expect(out).toMatch(/- src\/x\.ts$/m)
  })
})
