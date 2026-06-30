import { v4 as uuid } from "uuid"
import type { DocumentMeta, TextChunk, RAGContext, VectorSearchResult } from "../types/rag"
import { ollamaUrl, localFetch } from "./backend"

export async function extractText(file: File): Promise<string> {
  const ext = file.name.split(".").pop()?.toLowerCase()
  try {
    if (ext === "pdf") return await extractTextFromPDF(file)
    if (ext === "docx") return await extractTextFromDOCX(file)
    return await file.text()
  } catch (err) {
    throw new Error(
      `Failed to extract text from "${file.name}": ${err instanceof Error ? err.message : String(err)}`
    )
  }
}

async function extractTextFromPDF(file: File): Promise<string> {
  const pdfjsLib = await import("pdfjs-dist")
  // Use local worker — never load from CDN to protect privacy
  pdfjsLib.GlobalWorkerOptions.workerSrc = new URL('pdfjs-dist/build/pdf.worker.min.mjs', import.meta.url).href
  const arrayBuffer = await file.arrayBuffer()
  const doc = await pdfjsLib.getDocument({ data: arrayBuffer }).promise
  const pages: string[] = []
  for (let i = 1; i <= doc.numPages; i++) {
    const page = await doc.getPage(i)
    const textContent = await page.getTextContent()
    pages.push(textContent.items.map((item: any) => item.str).join(" "))
  }
  return pages.join("\n\n")
}

async function extractTextFromDOCX(file: File): Promise<string> {
  const mammoth = await import("mammoth")
  const arrayBuffer = await file.arrayBuffer()
  const result = await mammoth.extractRawText({ arrayBuffer })
  return result.value
}

export function chunkText(
  text: string,
  chunkSize = 500,
  overlap = 50
): string[] {
  const chunks: string[] = []
  const sentences = text.split(/(?<=[.!?])\s+/)
  let current = ""

  for (const sentence of sentences) {
    if ((current + " " + sentence).length > chunkSize && current) {
      chunks.push(current.trim())
      const words = current.split(" ")
      const overlapWords = words.slice(-Math.ceil(overlap / 5))
      current = overlapWords.join(" ") + " " + sentence
    } else {
      current += (current ? " " : "") + sentence
    }
  }
  if (current.trim()) chunks.push(current.trim())
  return chunks.filter((c) => c.length > 20)
}

export async function generateEmbeddings(
  texts: string[],
  model = "nomic-embed-text"
): Promise<number[][]> {
  let res: Response
  try {
    res = await localFetch(ollamaUrl("/embed"), {
      method: "POST",
      body: JSON.stringify({ model, input: texts }),
    })
  } catch (err) {
    throw new Error(
      `Cannot reach Ollama. Is it running? (${err instanceof Error ? err.message : String(err)})`
    )
  }

  if (!res.ok) {
    let detail = ""
    try {
      const body = await res.json()
      detail = body?.error || ""
    } catch { /* ignore parse errors */ }

    if (res.status === 404 || detail.includes("not found")) {
      throw new Error(
        `Embedding model "${model}" not found. Run: ollama pull ${model}`
      )
    }
    throw new Error(
      `Embedding failed (HTTP ${res.status}): ${detail || "Unknown error"}`
    )
  }

  const data = await res.json()
  if (!data.embeddings || !Array.isArray(data.embeddings)) {
    throw new Error("Unexpected response from Ollama /embed endpoint")
  }
  return data.embeddings
}

export function cosineSimilarity(a: number[], b: number[]): number {
  let dot = 0,
    magA = 0,
    magB = 0
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i]
    magA += a[i] * a[i]
    magB += b[i] * b[i]
  }
  return dot / (Math.sqrt(magA) * Math.sqrt(magB) || 1)
}

export function bm25Score(query: string, document: string, allDocs: string[]): number {
  const queryTerms = query.toLowerCase().split(/\s+/)
  const docTerms = document.toLowerCase().split(/\s+/)
  const docLen = docTerms.length
  const numDocs = allDocs.length || 1
  const avgDl = allDocs.reduce((sum, d) => sum + d.split(/\s+/).length, 0) / numDocs || 200
  const k1 = 1.2
  const b = 0.75

  let score = 0
  for (const term of queryTerms) {
    const tf = docTerms.filter((t) => t === term).length
    const docsWithTerm = allDocs.filter(d => d.toLowerCase().includes(term)).length
    const idf = Math.log((numDocs - docsWithTerm + 0.5) / (docsWithTerm + 0.5) + 1)
    score += idf * ((tf * (k1 + 1)) / (tf + k1 * (1 - b + (b * docLen) / avgDl)))
  }
  return score
}

function hybridSearch(
  queryEmbedding: number[],
  query: string,
  chunks: TextChunk[],
  topK = 5
): VectorSearchResult[] {
  // Get vector scores
  const vectorResults = chunks.map((chunk) => ({
    chunk,
    vectorScore: cosineSimilarity(queryEmbedding, chunk.embedding),
  }))

  // Get BM25 scores (pass all docs for proper IDF calculation)
  const allDocTexts = chunks.map(c => c.content)
  const bm25Results = chunks.map((chunk) => ({
    chunk,
    bm25Score: bm25Score(query, chunk.content, allDocTexts),
  }))

  // Normalize both score sets to 0-1
  const maxVector = Math.max(...vectorResults.map((r) => r.vectorScore), 0.001)
  const maxBm25 = Math.max(...bm25Results.map((r) => r.bm25Score), 0.001)

  // Combine with 0.7 vector + 0.3 BM25 weighting
  const combined = chunks.map((chunk, i) => ({
    chunk,
    score:
      0.7 * (vectorResults[i].vectorScore / maxVector) +
      0.3 * (bm25Results[i].bm25Score / maxBm25),
  }))

  return combined.sort((a, b) => b.score - a.score).slice(0, topK)
}

export function searchVectors(
  queryEmbedding: number[],
  chunks: TextChunk[],
  topK = 5
): VectorSearchResult[] {
  return chunks
    .map((chunk) => ({ chunk, score: cosineSimilarity(queryEmbedding, chunk.embedding) }))
    .sort((a, b) => b.score - a.score)
    .slice(0, topK)
}

export async function indexDocument(
  file: File,
  embeddingModel = "nomic-embed-text"
): Promise<{ meta: DocumentMeta; chunks: TextChunk[] }> {
  const text = await extractText(file)
  const rawChunks = chunkText(text)
  const embeddings = await generateEmbeddings(rawChunks, embeddingModel)

  const docId = uuid()
  const chunks: TextChunk[] = rawChunks.map((content, index) => ({
    id: uuid(),
    documentId: docId,
    content,
    embedding: embeddings[index],
    index,
  }))

  const meta: DocumentMeta = {
    id: docId,
    name: file.name,
    type: file.name.split(".").pop()?.toLowerCase() as "pdf" | "docx" | "txt",
    size: file.size,
    addedAt: Date.now(),
    chunkCount: chunks.length,
  }

  return { meta, chunks }
}

export interface RetrieveResult {
  context: RAGContext
  scoredChunks: VectorSearchResult[]
}

export async function retrieveContext(
  query: string,
  chunks: TextChunk[],
  embeddingModel = "nomic-embed-text",
  topK = 5
): Promise<RetrieveResult> {
  const [queryEmb] = await generateEmbeddings([query], embeddingModel)
  const results = hybridSearch(queryEmb, query, chunks, topK)
  return {
    context: {
      chunks: results.map((r) => r.chunk),
      query,
      documentIds: [...new Set(results.map((r) => r.chunk.documentId))],
    },
    scoredChunks: results,
  }
}
