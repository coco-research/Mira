import { describe, it, expect, beforeEach } from 'vitest'
import {
  setActiveChatId,
  setActiveWorkspace,
  getActiveWorkspace,
  clearActiveChatId,
  renderWorkspaceSection,
} from '../agent-context'

describe('agent-context — active workspace pointer', () => {
  beforeEach(() => {
    clearActiveChatId()
  })

  it('starts null', () => {
    expect(getActiveWorkspace()).toBeNull()
  })

  it('stores a folder workspace', () => {
    setActiveWorkspace({ kind: 'folder', path: '/Users/me/repo' })
    expect(getActiveWorkspace()).toEqual({
      kind: 'folder',
      path: '/Users/me/repo',
    })
  })

  it('sandbox workspaces leave the pointer null', () => {
    // Tools fall back to the bridge's per-chat sandbox path; we don't want
    // chatCtx() to send workingDirectory in that case.
    setActiveWorkspace({ kind: 'sandbox' })
    expect(getActiveWorkspace()).toBeNull()
  })

  it('folder workspace without a path is treated like sandbox', () => {
    setActiveWorkspace({ kind: 'folder' })
    expect(getActiveWorkspace()).toBeNull()
  })

  it('null / undefined explicitly clear the pointer', () => {
    setActiveWorkspace({ kind: 'folder', path: '/a' })
    setActiveWorkspace(null)
    expect(getActiveWorkspace()).toBeNull()
    setActiveWorkspace({ kind: 'folder', path: '/b' })
    setActiveWorkspace(undefined)
    expect(getActiveWorkspace()).toBeNull()
  })

  it('clearActiveChatId drops the workspace too', () => {
    setActiveChatId('chat-1')
    setActiveWorkspace({ kind: 'folder', path: '/x' })
    clearActiveChatId()
    expect(getActiveWorkspace()).toBeNull()
  })

  // ── multi-repo extras (Sprint C #8) ──────────────────────────────

  it('keeps extraPaths when they are non-empty distinct strings', () => {
    setActiveWorkspace({
      kind: 'folder',
      path: '/Users/me/repo-a',
      extraPaths: ['/Users/me/repo-b', '/Users/me/repo-c'],
    })
    expect(getActiveWorkspace()).toEqual({
      kind: 'folder',
      path: '/Users/me/repo-a',
      extraPaths: ['/Users/me/repo-b', '/Users/me/repo-c'],
    })
  })

  it('dedupes extras and removes blanks / primary collisions', () => {
    setActiveWorkspace({
      kind: 'folder',
      path: '/a',
      extraPaths: ['/b', '/b', '', '/a', '/c'],
    })
    expect(getActiveWorkspace()).toEqual({
      kind: 'folder',
      path: '/a',
      extraPaths: ['/b', '/c'],
    })
  })

  it('drops the extras field entirely when nothing survives the filter', () => {
    setActiveWorkspace({ kind: 'folder', path: '/a', extraPaths: ['', '/a'] })
    expect(getActiveWorkspace()).toEqual({ kind: 'folder', path: '/a' })
  })
})

describe('renderWorkspaceSection', () => {
  it('returns empty for sandbox / missing path', () => {
    expect(renderWorkspaceSection(null)).toBe('')
    expect(renderWorkspaceSection({ kind: 'sandbox' })).toBe('')
    expect(renderWorkspaceSection({ kind: 'folder' })).toBe('')
  })

  it('returns a single-line primary when there are no extras', () => {
    const out = renderWorkspaceSection({ kind: 'folder', path: '/a' })
    expect(out).toBe('\n\nPrimary workspace: /a')
  })

  it('lists primary + extras when extras are present', () => {
    const out = renderWorkspaceSection({
      kind: 'folder',
      path: '/a',
      extraPaths: ['/b', '/c'],
    })
    expect(out).toMatch(/Workspaces/)
    expect(out).toMatch(/Primary:\s+\/a/)
    expect(out).toMatch(/Extra:\s+\/b/)
    expect(out).toMatch(/Extra:\s+\/c/)
  })
})
