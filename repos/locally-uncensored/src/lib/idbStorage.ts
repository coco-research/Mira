/**
 * IndexedDB-backed Zustand persist storage (v2.5.0).
 *
 * WHY: chat history + memories were persisted to localStorage, whose hard
 * ~5 MB per-origin cap is far too small for real chat history (long threads,
 * inline images, imported transcripts). localStorage is also the wrong tool —
 * it's a tiny synchronous key/value store. The standard fix web apps use is
 * IndexedDB, which is disk-backed and scales to tens of GB (Chromium grants an
 * origin up to ~60% of free disk, more with persistent-storage). LU already
 * uses IndexedDB for RAG chunks + memory embeddings; this brings the chat +
 * memory STORES onto the same durable, large backend.
 *
 * DESIGN:
 *   - idb-first, with a ONE-TIME migration read from the legacy localStorage
 *     key (so existing users keep their chats/memories on upgrade), after which
 *     the localStorage copy is dropped to free that 5 MB.
 *   - SYNC localStorage fallback when IndexedDB is unavailable (the vitest
 *     `node` env, or a degraded webview). Returning a plain value (not a
 *     Promise) there keeps Zustand hydration synchronous in tests — exactly the
 *     old behaviour — so the suite is unaffected. In the real WebView2 app
 *     `indexedDB` exists, so getItem/setItem return Promises and persist
 *     hydrates asynchronously (a sub-100 ms tick on launch).
 *   - `navigator.storage.persist()` is requested once so the browser treats the
 *     data as durable and never evicts it under pressure.
 *
 * Still wrapped in `createJSONStorage(() => idbStorage)` at the call site — the
 * FIX-3 lesson: Zustand v5 `storage` needs a PersistStorage, and createJSONStorage
 * does the object<->string (de)serialisation around this string StateStorage.
 */
import type { StateStorage } from 'zustand/middleware'

const DB_NAME = 'locally-uncensored-store'
const STORE = 'kv'
const DB_VERSION = 1

// FIX-3-era corrupt localStorage value ("[object Object]"). Must never be
// hydrated or migrated — treat it as absent so the store starts clean.
const LEGACY_CORRUPT = '[object Object]'

function lsGet(k: string): string | null {
  try { return typeof localStorage !== 'undefined' ? localStorage.getItem(k) : null } catch { return null }
}
function lsSet(k: string, v: string): void {
  try { if (typeof localStorage !== 'undefined') localStorage.setItem(k, v) } catch { /* quota/SSR */ }
}
function lsDel(k: string): void {
  try { if (typeof localStorage !== 'undefined') localStorage.removeItem(k) } catch { /* SSR */ }
}

const hasIDB: boolean = (() => {
  try { return typeof indexedDB !== 'undefined' && indexedDB !== null } catch { return false }
})()

let _db: Promise<IDBDatabase> | null = null
function getDB(): Promise<IDBDatabase> {
  if (_db) return _db
  _db = new Promise<IDBDatabase>((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION)
    req.onupgradeneeded = () => {
      const db = req.result
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE)
    }
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
    req.onblocked = () => reject(new Error('indexedDB open blocked'))
  })
  return _db
}

function idbGet(key: string): Promise<string | null> {
  return getDB().then((db) => new Promise<string | null>((resolve) => {
    const tx = db.transaction(STORE, 'readonly')
    const r = tx.objectStore(STORE).get(key)
    r.onsuccess = () => resolve(typeof r.result === 'string' ? r.result : null)
    r.onerror = () => resolve(null)
  }))
}
function idbSet(key: string, value: string): Promise<void> {
  return getDB().then((db) => new Promise<void>((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite')
    tx.objectStore(STORE).put(value, key)
    tx.oncomplete = () => resolve()
    tx.onerror = () => reject(tx.error)
    tx.onabort = () => reject(tx.error)
  }))
}
function idbDel(key: string): Promise<void> {
  return getDB().then((db) => new Promise<void>((resolve) => {
    const tx = db.transaction(STORE, 'readwrite')
    tx.objectStore(STORE).delete(key)
    tx.oncomplete = () => resolve()
    tx.onerror = () => resolve()
  }))
}

let _persistAsked = false
function askPersist(): void {
  if (_persistAsked) return
  _persistAsked = true
  try {
    const s = (navigator as any)?.storage
    if (s && typeof s.persist === 'function') s.persist().catch(() => {})
  } catch { /* not supported */ }
}

export const idbStorage: StateStorage = {
  getItem(name: string): string | null | Promise<string | null> {
    if (!hasIDB) return lsGet(name) // sync path: node tests / degraded webview
    askPersist()
    return (async () => {
      try {
        const v = await idbGet(name)
        if (v != null) return v
        // One-time migration from the legacy localStorage backend.
        const legacy = lsGet(name)
        if (legacy != null && legacy !== LEGACY_CORRUPT) {
          // Migrate into idb, then drop the localStorage copy so the ~5 MB cap is
          // freed immediately (only on confirmed idb write — keep it if idb fails).
          try { await idbSet(name, legacy); lsDel(name) } catch { /* keep localStorage */ }
          return legacy
        }
        return null
      } catch {
        return lsGet(name) // idb failed at runtime → localStorage
      }
    })()
  },
  setItem(name: string, value: string): void | Promise<void> {
    if (!hasIDB) { lsSet(name, value); return }
    return (async () => {
      try {
        await idbSet(name, value)
        lsDel(name) // drop the migrated localStorage copy → frees the 5 MB cap
      } catch {
        lsSet(name, value) // idb write failed → localStorage best-effort
      }
    })()
  },
  removeItem(name: string): void | Promise<void> {
    if (!hasIDB) { lsDel(name); return }
    return (async () => { try { await idbDel(name) } catch { /* ignore */ } ; lsDel(name) })()
  },
}
