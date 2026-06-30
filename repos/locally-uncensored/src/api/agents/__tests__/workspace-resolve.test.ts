import { describe, it, expect } from 'vitest'
import { resolveWorkspace, resolveWorkspacePath } from '../workspace-resolve'

describe('resolveWorkspace', () => {
  it('returns null when neither layer has a workspace', () => {
    expect(resolveWorkspace({ perChat: undefined, defaultWorkspace: null })).toBeNull()
  })

  it('prefers per-chat over default', () => {
    const out = resolveWorkspace({
      perChat: { kind: 'folder', path: '/a' },
      defaultWorkspace: { kind: 'folder', path: '/b' },
    })
    expect(out).toEqual({ kind: 'folder', path: '/a' })
  })

  it('falls back to default when per-chat is undefined', () => {
    const out = resolveWorkspace({
      perChat: undefined,
      defaultWorkspace: { kind: 'folder', path: '/d' },
    })
    expect(out).toEqual({ kind: 'folder', path: '/d' })
  })

  it('a sandbox per-chat is still a real choice — does NOT fall through to default', () => {
    const out = resolveWorkspace({
      perChat: { kind: 'sandbox' },
      defaultWorkspace: { kind: 'folder', path: '/d' },
    })
    expect(out).toEqual({ kind: 'sandbox' })
  })
})

describe('resolveWorkspacePath', () => {
  it('returns null for sandbox per-chat (even with a default folder)', () => {
    expect(
      resolveWorkspacePath({
        perChat: { kind: 'sandbox' },
        defaultWorkspace: { kind: 'folder', path: '/d' },
      }),
    ).toBeNull()
  })

  it('returns the primary path when one is set', () => {
    expect(
      resolveWorkspacePath({
        perChat: undefined,
        defaultWorkspace: { kind: 'folder', path: '/d' },
      }),
    ).toBe('/d')
  })

  it('returns null when nothing is set', () => {
    expect(resolveWorkspacePath({ perChat: undefined, defaultWorkspace: null })).toBeNull()
  })
})
