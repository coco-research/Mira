import { useCallback, useEffect, useRef } from "react"
import { useShallow } from "zustand/react/shallow"
import { useRAGStore } from "../stores/ragStore"
import { indexDocument, retrieveContext } from "../api/rag"
import { getModelContext, listModels, pullModelTauri, checkConnection } from "../api/ollama"
import { useModelStore } from "../stores/modelStore"
import type { DocumentMeta, RAGContext } from "../types/rag"
import { log } from "../lib/logger"

const EMPTY_DOCS: DocumentMeta[] = []

export function useRAG(conversationId: string | null) {
  const {
    documents,
    isEnabled,
    isIndexing,
    indexingProgress,
    contextWarning,
    pullingEmbeddingModel,
    chunksLoaded,
  } = useRAGStore(
    useShallow((s) => ({
      documents: conversationId ? s.documents[conversationId] ?? EMPTY_DOCS : EMPTY_DOCS,
      isEnabled: conversationId ? s.ragEnabled[conversationId] ?? false : false,
      isIndexing: s.isIndexing,
      indexingProgress: s.indexingProgress,
      contextWarning: s.contextWarning,
      pullingEmbeddingModel: s.pullingEmbeddingModel,
      chunksLoaded: s.chunksLoaded,
    }))
  )

  // Track which conversations we've already loaded chunks for
  const loadedRef = useRef<Set<string>>(new Set())

  // Auto-load chunks from IndexedDB when conversation has documents
  useEffect(() => {
    if (!conversationId || documents.length === 0) return
    if (loadedRef.current.has(conversationId)) return
    loadedRef.current.add(conversationId)
    useRAGStore.getState().loadChunksFromDB(conversationId)
  }, [conversationId, documents.length])

  // Check context window when RAG is toggled on or documents change
  useEffect(() => {
    if (!isEnabled || !conversationId) {
      // Only clear if there's actually a warning set
      if (useRAGStore.getState().contextWarning !== null) {
        useRAGStore.getState().setContextWarning(null)
      }
      return
    }

    const checkContextWindow = async () => {
      const activeModel = useModelStore.getState().activeModel
      if (!activeModel) return

      try {
        const ctxLen = await getModelContext(activeModel)
        if (ctxLen <= 2048) {
          useRAGStore.getState().setContextWarning(
            `Your model's context window is only ${ctxLen} tokens. RAG works best with 4096+ tokens. Run: ollama run ${activeModel} /set parameter num_ctx 8192`
          )
        } else if (useRAGStore.getState().contextWarning !== null) {
          useRAGStore.getState().setContextWarning(null)
        }
      } catch {
        // Silently fail context check
      }
    }

    checkContextWindow()
  }, [isEnabled, conversationId, documents.length])

  /**
   * Verify the embedding model is reachable. Used both as upload pre-flight
   * (`uploadDocument` queues the file when this returns false) and standalone
   * from the post-update banner / Install card so the UI can ask once and
   * not re-probe per file.
   *
   * Returns true when nomic-embed-text (or whatever `embeddingModel` is set
   * to) is in Ollama's model list. False when missing — caller is expected
   * to surface the in-app Install prompt rather than blocking.
   */
  const ensureEmbeddingModel = useCallback(async (): Promise<boolean> => {
    const { embeddingModel } = useRAGStore.getState()
    const ollamaUp = await checkConnection()
    if (!ollamaUp) return false
    try {
      const models = await listModels()
      return models.some(
        (m) => m.name === embeddingModel || m.name === embeddingModel + ":latest"
      )
    } catch {
      return false
    }
  }, [])

  /**
   * Run `ollama pull <embeddingModel>` with byte-level progress streamed into
   * `embeddingPullProgress`. Replaces the pre-v2.4.9 fire-and-forget pull whose
   * console.log progress lines were invisible to the user.
   *
   * Uses `pullModelTauri` (event-based) — NOT `pullModel` (Response.body). The
   * Tauri `localFetchStream` proxy collects all bytes before returning the
   * Response on Windows release builds, so reading the body stream sees a
   * single chunk at the very end of the pull (this is the same Bug M issue
   * v2.4.7 fixed for benchmark TTFT). Onboarding's F45 step already uses
   * `pullModelTauri` for the same reason — this routine matches it so users
   * get a smoothly-updating progress bar whether they install via Onboarding,
   * RAGPanel install card, or any future entry point.
   */
  const pullEmbeddingModel = useCallback(async (): Promise<boolean> => {
    const {
      embeddingModel,
      setPullingEmbeddingModel,
      setEmbeddingPullProgress,
    } = useRAGStore.getState()

    setPullingEmbeddingModel(true)
    setEmbeddingPullProgress({ completed: 0, total: 0, status: "starting" })

    try {
      const { promise } = pullModelTauri(embeddingModel, (p) => {
        const status = (p.status || "").toLowerCase()
        const isComplete = status.includes("success") || status === "complete"
        setEmbeddingPullProgress({
          completed: p.completed || 0,
          total: p.total || 0,
          status: isComplete ? "success" : p.status || "downloading",
        })
      })
      await promise
      return true
    } catch (err) {
      log.error("[EmbeddingPull] failed", { err })
      return false
    } finally {
      setPullingEmbeddingModel(false)
      // Leave the progress visible briefly so the success state isn't a
      // flicker — RAGPanel hides it on next render anyway.
      setTimeout(() => setEmbeddingPullProgress(null), 1500)
    }
  }, [])

  const uploadDocument = useCallback(
    async (file: File): Promise<DocumentMeta | null> => {
      if (!conversationId) return null

      const {
        embeddingModel,
        setIndexing,
        setIndexingProgress,
        addDocument,
        addChunks,
        setEmbeddingInstallPrompt,
        queueEmbeddingFile,
      } = useRAGStore.getState()

      // Pre-flight: Ollama reachable?
      const ollamaUp = await checkConnection()
      if (!ollamaUp) {
        throw new Error(
          "Ollama is not running. Please start Ollama first, then try again."
        )
      }

      // Embedding model present?  When missing we queue the file + flip the
      // RAGPanel install-prompt flag rather than blocking via the OS confirm
      // dialog. The user clicks Download in the in-app card → pullEmbedding
      // Model fires → on success the queued files replay automatically.
      const hasEmbedding = await ensureEmbeddingModel()
      if (!hasEmbedding) {
        queueEmbeddingFile(file)
        setEmbeddingInstallPrompt(true)
        return null
      }

      try {
        setIndexing(true)
        setIndexingProgress({ current: 0, total: 1 })

        const { meta, chunks } = await indexDocument(file, embeddingModel)

        if (chunks.length === 0) {
          throw new Error(
            "No text could be extracted from this file. The document may be empty or contain only images."
          )
        }

        addDocument(conversationId, meta)
        addChunks(chunks)
        setIndexingProgress({ current: 1, total: 1 })

        return meta
      } catch (err) {
        log.error("Failed to index document", { err })
        throw err
      } finally {
        setIndexing(false)
        setIndexingProgress(null)
      }
    },
    [conversationId, ensureEmbeddingModel]
  )

  /**
   * Triggered from the in-app Install card or the post-update banner. Pulls
   * the embedding model, then drains any files the user dropped while we
   * waited. The drain re-enters `uploadDocument` so any later error handling
   * (extraction failures, bogus PDFs) reuses the same surface.
   */
  const installEmbeddingAndDrainQueue = useCallback(async (): Promise<void> => {
    const { setEmbeddingInstallPrompt, clearEmbeddingQueue } = useRAGStore.getState()
    const ok = await pullEmbeddingModel()
    setEmbeddingInstallPrompt(false)
    if (!ok) return // error surfaced via console; user sees status in progress card
    // Drain queue — copy first because uploadDocument doesn't touch the
    // queue, but a stale snapshot is safer than reading state mid-loop.
    const queue = [...useRAGStore.getState().embeddingQueuedFiles]
    clearEmbeddingQueue()
    for (const queued of queue) {
      try {
        await uploadDocument(queued)
      } catch (err) {
        // RAGPanel already handles per-file error display via its own
        // setError when the upload throws — log here for diagnostics only.
        log.error("[EmbeddingDrain] queued file failed", { name: queued.name, err })
      }
    }
  }, [pullEmbeddingModel, uploadDocument])

  const cancelEmbeddingInstall = useCallback(() => {
    const { setEmbeddingInstallPrompt, clearEmbeddingQueue } = useRAGStore.getState()
    setEmbeddingInstallPrompt(false)
    clearEmbeddingQueue()
  }, [])

  const removeDoc = useCallback(
    (docId: string) => {
      if (!conversationId) return
      useRAGStore.getState().removeDocument(conversationId, docId)
    },
    [conversationId]
  )

  const toggleRAG = useCallback(() => {
    if (!conversationId) return
    const { ragEnabled, setRagEnabled } = useRAGStore.getState()
    setRagEnabled(conversationId, !ragEnabled[conversationId])
  }, [conversationId])

  const getContextForQuery = useCallback(
    async (query: string): Promise<RAGContext | null> => {
      if (!conversationId) return null

      const { getConversationChunks, embeddingModel } = useRAGStore.getState()
      const chunks = getConversationChunks(conversationId)

      if (chunks.length === 0) return null

      const { context } = await retrieveContext(query, chunks, embeddingModel)
      return context
    },
    [conversationId]
  )

  const clearAll = useCallback(() => {
    if (!conversationId) return
    const { clearConversationDocs, setLastRetrievedChunks } = useRAGStore.getState()
    clearConversationDocs(conversationId)
    setLastRetrievedChunks([])
  }, [conversationId])

  return {
    documents,
    isEnabled,
    isIndexing,
    indexingProgress,
    contextWarning,
    pullingEmbeddingModel,
    chunksLoaded,
    uploadDocument,
    removeDocument: removeDoc,
    toggleRAG,
    clearAll,
    getContextForQuery,
    ensureEmbeddingModel,
    pullEmbeddingModel,
    installEmbeddingAndDrainQueue,
    cancelEmbeddingInstall,
  }
}
