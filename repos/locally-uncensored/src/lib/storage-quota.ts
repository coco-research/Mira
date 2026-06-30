/**
 * localStorage quota protection — prevents QuotaExceededError from
 * corrupting Zustand persisted stores.
 */

import type { StateStorage } from 'zustand/middleware'
import { log } from './logger'

const MAX_CONVERSATIONS = 100
// Memory store key + how many entries we keep when evicting under quota
// pressure. 500 is generous — extraction is opt-in and entries are small
// (~title + description + ≤500-char content), so a user rarely has this
// many. The cap only ever bites on the QuotaExceeded retry path.
const MEMORY_STORE_KEY = 'locally-uncensored-memory'
const MAX_MEMORIES = 500

function getLS(): Storage | null {
  try { return typeof localStorage !== 'undefined' ? localStorage : null } catch { return null }
}

/** Estimate total localStorage usage in bytes. */
export function getStorageUsage(): { usedBytes: number; percentFull: number } {
  const ls = getLS()
  if (!ls) return { usedBytes: 0, percentFull: 0 }
  let total = 0
  for (let i = 0; i < ls.length; i++) {
    const key = ls.key(i)
    if (key) {
      total += key.length + (ls.getItem(key)?.length || 0)
    }
  }
  const usedBytes = total * 2
  const estimatedLimit = 5 * 1024 * 1024
  return { usedBytes, percentFull: usedBytes / estimatedLimit }
}

/** Prune oldest conversations from chat store to free space. */
function pruneOldConversations(): boolean {
  const ls = getLS()
  if (!ls) return false
  try {
    const raw = ls.getItem('chat-conversations')
    if (!raw) return false

    const data = JSON.parse(raw)
    if (!data?.state?.conversations || !Array.isArray(data.state.conversations)) return false

    const convs = data.state.conversations
    if (convs.length <= MAX_CONVERSATIONS) return false

    convs.sort((a: any, b: any) => (b.updatedAt || 0) - (a.updatedAt || 0))
    data.state.conversations = convs.slice(0, MAX_CONVERSATIONS)
    ls.setItem('chat-conversations', JSON.stringify(data))
    return true
  } catch {
    return false
  }
}

/**
 * Evict the lowest-value memories from the `locally-uncensored-memory`
 * store to free space, parallel to {@link pruneOldConversations}. Ranks
 * entries worst-first (stale → superseded → oldest by updatedAt) and keeps
 * the top {@link MAX_MEMORIES}. Returns true only when it actually wrote a
 * smaller list, so the caller knows a retry has a real chance to succeed.
 *
 * Conservative by design: it never touches an under-cap store, and the
 * ranking favours keeping recent, live, non-superseded facts — the ones
 * retrieval actually uses.
 */
function pruneOldMemories(): boolean {
  const ls = getLS()
  if (!ls) return false
  try {
    const raw = ls.getItem(MEMORY_STORE_KEY)
    if (!raw) return false

    const data = JSON.parse(raw)
    if (!data?.state?.entries || !Array.isArray(data.state.entries)) return false

    const entries = data.state.entries
    if (entries.length <= MAX_MEMORIES) return false

    // Lower score = evicted first. Stale and superseded entries are dead
    // weight for retrieval, so they go before any live entry regardless of
    // age; among the rest, newer `updatedAt` wins.
    const scoreOf = (e: any): number => {
      let s = e?.updatedAt || e?.createdAt || 0
      if (e?.stale) s -= 1e15
      if (e?.supersededBy) s -= 1e14
      return s
    }
    entries.sort((a: any, b: any) => scoreOf(b) - scoreOf(a))
    data.state.entries = entries.slice(0, MAX_MEMORIES)
    ls.setItem(MEMORY_STORE_KEY, JSON.stringify(data))
    return true
  } catch {
    return false
  }
}

/**
 * Fire a one-time UI signal that a write was dropped because storage is
 * full. Listeners (see AppShell's StorageQuotaToast) debounce this into a
 * single non-spammy warning. Wrapped in try/catch + existence guards so it
 * is a no-op in non-DOM environments (SSR, unit tests without jsdom).
 */
function notifyQuotaExceeded(key: string): void {
  try {
    if (typeof window !== 'undefined' && typeof window.dispatchEvent === 'function') {
      window.dispatchEvent(new CustomEvent('lu:storage-quota-exceeded', { detail: { key } }))
    }
  } catch {
    // Best-effort UI hint — never let it mask the original write failure.
  }
}

/**
 * Create a safe Zustand storage adapter that catches QuotaExceededError,
 * attempts to free space by pruning old conversations, and retries once.
 * Falls back to default localStorage behavior if unavailable (e.g., tests).
 */
export function createSafeStorage(): StateStorage {
  return {
    getItem(name: string): string | null {
      const ls = getLS()
      return ls ? ls.getItem(name) : null
    },
    setItem(name: string, value: string): void {
      const ls = getLS()
      if (!ls) return
      try {
        ls.setItem(name, value)
      } catch (err) {
        if (err instanceof DOMException && err.name === 'QuotaExceededError') {
          // Tier 1: drop oldest conversations (the usual space hog), retry.
          if (pruneOldConversations()) {
            try {
              ls.setItem(name, value)
              return
            } catch {
              // Still full — fall through to memory pruning.
            }
          }
          // Tier 2: evict lowest-value memories, retry. Gives a memory write
          // (or any other write) a real second chance when convs<=100 so the
          // conversation prune was a no-op — the exact case that used to lose
          // the write silently.
          if (pruneOldMemories()) {
            try {
              ls.setItem(name, value)
              return
            } catch {
              // Still full.
            }
          }
          // Out of options: tell the UI (once) so the user can free space,
          // then warn. Previously the write just vanished with only a console
          // line no one sees.
          notifyQuotaExceeded(name)
          log.warn(`[storage-quota] QuotaExceededError for "${name}" — data not persisted`)
        } else {
          throw err
        }
      }
    },
    removeItem(name: string): void {
      const ls = getLS()
      if (ls) ls.removeItem(name)
    },
  }
}
