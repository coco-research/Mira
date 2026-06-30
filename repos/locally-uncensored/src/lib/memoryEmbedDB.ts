/**
 * IndexedDB persistence for MEMORY embeddings (Feature FF, v2.5.0).
 *
 * Modeled 1:1 on ragDB.ts. Memory entries live in localStorage (the Zustand
 * `locally-uncensored-memory` store), but their nomic-embed-text vectors are
 * 768 floats each — far too large for the ~5 MB localStorage budget. We keep
 * the vectors out of localStorage entirely and stash them here, keyed by the
 * memory entry id.
 *
 * Schema:
 *   DB: "locally-uncensored-memory-embeddings" (v1)
 *   ObjectStore: "vectors" — key: memory entry id, value: MemoryVectorRecord
 *
 * The record stores `model` + `dim` alongside the vector so the retrieval
 * layer can skip / clear vectors whose dimensionality no longer matches the
 * current query embedding (treat dim-mismatch as a fallback-to-keyword), and
 * `contentHash` so the store only re-embeds when an entry's content actually
 * changes (mirrors embedding-router's descriptionHash trick).
 *
 * Every public function is a best-effort no-op when `indexedDB` is
 * unavailable (e.g. the node-based vitest environment) so callers — the
 * memory store's CRUD enqueue path in particular — never throw off the main
 * code path.
 */

export interface MemoryVectorRecord {
  /** Embedding model that produced the vector (e.g. "nomic-embed-text"). */
  model: string
  /** Vector length — used to reject dim-mismatched vectors at query time. */
  dim: number
  /** The embedding itself. */
  vector: number[]
  /** djb2 hash of the embedded text — re-embed only when this changes. */
  contentHash: string
}

const DB_NAME = "locally-uncensored-memory-embeddings"
const DB_VERSION = 1
const STORE_NAME = "vectors"

let dbPromise: Promise<IDBDatabase> | null = null

/** True when IndexedDB exists in this runtime (false under node/vitest). */
function hasIDB(): boolean {
  return typeof indexedDB !== "undefined" && indexedDB !== null
}

function openDB(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise

  dbPromise = new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION)

    request.onupgradeneeded = () => {
      const db = request.result
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME)
      }
    }

    request.onsuccess = () => resolve(request.result)
    request.onerror = () => {
      dbPromise = null
      reject(request.error)
    }
  })

  return dbPromise
}

function tx(mode: IDBTransactionMode): Promise<IDBObjectStore> {
  return openDB().then((db) => {
    const transaction = db.transaction(STORE_NAME, mode)
    return transaction.objectStore(STORE_NAME)
  })
}

function idbRequest<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
  })
}

/** Save (or overwrite) the embedding for a memory entry. No-op without IDB. */
export async function saveVector(id: string, record: MemoryVectorRecord): Promise<void> {
  if (!hasIDB()) return
  const store = await tx("readwrite")
  await idbRequest(store.put(record, id))
}

/**
 * Load the embeddings for the given memory ids into an id → record Map.
 * Missing ids are simply absent from the Map. Returns an empty Map without
 * IDB so the retrieval layer falls back to keyword scoring.
 */
export async function loadVectors(ids: string[]): Promise<Map<string, MemoryVectorRecord>> {
  const result = new Map<string, MemoryVectorRecord>()
  if (!hasIDB() || ids.length === 0) return result

  const store = await tx("readonly")
  for (const id of ids) {
    const rec = (await idbRequest(store.get(id))) as MemoryVectorRecord | undefined
    if (rec && Array.isArray(rec.vector)) result.set(id, rec)
  }
  return result
}

/** Delete the embedding for a memory entry. No-op without IDB. */
export async function deleteVector(id: string): Promise<void> {
  if (!hasIDB()) return
  const store = await tx("readwrite")
  await idbRequest(store.delete(id))
}

/** Delete every memory embedding (e.g. when clearing all memories). */
export async function clearAll(): Promise<void> {
  if (!hasIDB()) return
  const store = await tx("readwrite")
  await idbRequest(store.clear())
}

/**
 * Export every memory embedding as an `id → MemoryVectorRecord` map. Used by
 * the AppShell backup triad so memory vectors survive an NSIS upgrade /
 * WebView2 data wipe alongside the RAG chunks. Returns an empty object — not
 * null — when the store is empty so the snapshot file is always valid JSON.
 */
export async function exportAll(): Promise<Record<string, MemoryVectorRecord>> {
  const result: Record<string, MemoryVectorRecord> = {}
  if (!hasIDB()) return result

  const store = await tx("readonly")
  // openCursor() so we capture both the key (memory id) and the value
  // (MemoryVectorRecord) in one pass — getAll() would lose the ids.
  await new Promise<void>((resolve, reject) => {
    const req = store.openCursor()
    req.onsuccess = () => {
      const cursor = req.result
      if (!cursor) {
        resolve()
        return
      }
      result[String(cursor.key)] = cursor.value as MemoryVectorRecord
      cursor.continue()
    }
    req.onerror = () => reject(req.error)
  })
  return result
}

/**
 * Counterpart to `exportAll` — overwrites the IndexedDB vector store from a
 * serialized snapshot. Skips malformed entries (no vector array) so a corrupt
 * / partial snapshot can't blank out vectors already on disk that aren't in
 * the snapshot. Existing entries for the same id are replaced (last-writer-
 * wins, same semantics as `saveVector`). Returns the number restored.
 */
export async function importAll(snapshot: Record<string, MemoryVectorRecord>): Promise<number> {
  if (!hasIDB()) return 0
  const ids = Object.keys(snapshot || {})
  if (ids.length === 0) return 0
  const store = await tx("readwrite")
  let restored = 0
  for (const id of ids) {
    const rec = snapshot[id]
    if (!rec || !Array.isArray(rec.vector) || rec.vector.length === 0) continue
    await idbRequest(store.put(rec, id))
    restored++
  }
  return restored
}
