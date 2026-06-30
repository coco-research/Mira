/**
 * Memory Retrieval — blended scorer tests (Feature FF, v2.5.0).
 *
 * Pure-function tests with hand-built fake vectors (no Ollama, no IndexedDB),
 * mirroring src/api/__tests__/rag.test.ts. Covers:
 *   - semantic signal dominates keyword when weights say so
 *   - recency tie-break when semantic + keyword are equal
 *   - stale entries excluded by default, included with includeStale
 *   - dim-mismatched vectors fall back to keyword-only (no crash)
 *   - weight normalization (one candidate doesn't auto-win on raw scale)
 *
 * Run: npx vitest run src/lib/__tests__/memory-retrieval.test.ts
 */
import { describe, it, expect } from 'vitest'
import {
  scoreMemoriesBlended,
  isStale,
  SEMANTIC_WEIGHT,
  KEYWORD_WEIGHT,
  RECENCY_WEIGHT,
  TYPE_BOOST,
  type BlendCandidate,
} from '../memory-retrieval'
import type { MemoryFile, MemoryType } from '../../types/agent-mode'

// ── Helpers ──────────────────────────────────────────────────────

let _seq = 0
function mem(
  partial: Partial<MemoryFile> & { title: string; content: string },
): MemoryFile {
  _seq++
  return {
    id: partial.id ?? `m-${_seq}`,
    type: (partial.type ?? 'user') as MemoryType,
    title: partial.title,
    description: partial.description ?? partial.content.substring(0, 120),
    content: partial.content,
    tags: partial.tags ?? [],
    createdAt: partial.createdAt ?? 1_000,
    updatedAt: partial.updatedAt ?? 1_000,
    source: partial.source ?? 'test',
    stale: partial.stale,
    supersededBy: partial.supersededBy,
    supersedesId: partial.supersedesId,
    validFrom: partial.validFrom,
  }
}

function cand(m: MemoryFile, vector: number[] | null): BlendCandidate {
  return { memory: m, vector }
}

// ── Weight sanity ─────────────────────────────────────────────────

describe('blend weights', () => {
  it('sum to ~1.0', () => {
    expect(SEMANTIC_WEIGHT + KEYWORD_WEIGHT + RECENCY_WEIGHT).toBeCloseTo(1.0, 6)
  })
})

// ── isStale ───────────────────────────────────────────────────────

describe('isStale', () => {
  it('flags stale=true', () => {
    expect(isStale(mem({ title: 'a', content: 'a', stale: true }))).toBe(true)
  })
  it('flags supersededBy set', () => {
    expect(isStale(mem({ title: 'a', content: 'a', supersededBy: 'x' }))).toBe(true)
  })
  it('does not flag a normal entry', () => {
    expect(isStale(mem({ title: 'a', content: 'a' }))).toBe(false)
  })
})

// ── Semantic dominance ────────────────────────────────────────────

describe('semantic signal dominance', () => {
  it('ranks the semantically-closest entry first even when keyword favors another', () => {
    const query = [1, 0, 0]
    // A: orthogonal vector (semantic 0) but its text contains the query word.
    // B: identical vector (semantic 1) but NO query word in its text.
    const a = mem({ id: 'A', title: 'gizmo', content: 'gizmo widget gizmo' })
    const b = mem({ id: 'B', title: 'alpha', content: 'completely unrelated prose here' })
    const candidates = [cand(a, [0, 1, 0]), cand(b, [1, 0, 0])]

    const ranked = scoreMemoriesBlended(query, 'gizmo', candidates, { now: 2_000 })
    expect(ranked[0].memory.id).toBe('B')
    // Sanity: B's semantic term is the max (normalized to 1), A's is 0.
    const bScore = ranked.find((r) => r.memory.id === 'B')!
    expect(bScore.semantic).toBeCloseTo(1, 5)
  })
})

// ── Recency tie-break ─────────────────────────────────────────────

describe('recency tie-break', () => {
  it('newer entry wins when semantic + keyword are identical', () => {
    const query = [1, 0, 0]
    // Identical vectors + identical text → semantic & keyword tie. Only
    // updatedAt differs.
    const older = mem({ id: 'old', title: 'same fact', content: 'same fact text', updatedAt: 1_000 })
    const newer = mem({ id: 'new', title: 'same fact', content: 'same fact text', updatedAt: 9_000 })
    const candidates = [cand(older, [1, 0, 0]), cand(newer, [1, 0, 0])]

    const ranked = scoreMemoriesBlended(query, 'same fact text', candidates, { now: 10_000 })
    expect(ranked[0].memory.id).toBe('new')
    expect(ranked[0].score).toBeGreaterThan(ranked[1].score)
  })
})

// ── Type boost ────────────────────────────────────────────────────

describe('type boost', () => {
  it('user/feedback get an additive boost over project/reference at parity', () => {
    const query = [1, 0, 0]
    const u = mem({ id: 'u', type: 'user', title: 'x', content: 'x', updatedAt: 5_000 })
    const r = mem({ id: 'r', type: 'reference', title: 'x', content: 'x', updatedAt: 5_000 })
    const candidates = [cand(r, [1, 0, 0]), cand(u, [1, 0, 0])]

    const ranked = scoreMemoriesBlended(query, 'x', candidates, { now: 5_000 })
    expect(ranked[0].memory.id).toBe('u')
    const uScore = ranked.find((x) => x.memory.id === 'u')!.score
    const rScore = ranked.find((x) => x.memory.id === 'r')!.score
    expect(uScore - rScore).toBeCloseTo(TYPE_BOOST, 5)
  })
})

// ── Stale exclusion ───────────────────────────────────────────────

describe('stale exclusion', () => {
  it('excludes stale entries by default', () => {
    const query = [1, 0, 0]
    const live = mem({ id: 'live', title: 'fresh', content: 'fresh fact' })
    const dead = mem({ id: 'dead', title: 'old', content: 'old fact', stale: true })
    const ranked = scoreMemoriesBlended(query, 'fact', [cand(live, [1, 0, 0]), cand(dead, [1, 0, 0])], { now: 2_000 })
    expect(ranked.map((r) => r.memory.id)).toEqual(['live'])
  })

  it('includes stale entries when includeStale=true', () => {
    const query = [1, 0, 0]
    const live = mem({ id: 'live', title: 'fresh', content: 'fresh fact' })
    const dead = mem({ id: 'dead', title: 'old', content: 'old fact', supersededBy: 'live' })
    const ranked = scoreMemoriesBlended(
      query,
      'fact',
      [cand(live, [1, 0, 0]), cand(dead, [1, 0, 0])],
      { now: 2_000, includeStale: true },
    )
    expect(ranked.map((r) => r.memory.id).sort()).toEqual(['dead', 'live'])
  })
})

// ── Dim mismatch / null vectors → keyword-only, no crash ──────────

describe('vector robustness', () => {
  it('treats a null vector as semantic 0 (keyword + recency still rank it)', () => {
    const query = [1, 0, 0]
    const withVec = mem({ id: 'vec', title: 'apple', content: 'apple pie recipe' })
    const noVec = mem({ id: 'novec', title: 'apple', content: 'apple cider notes' })
    const ranked = scoreMemoriesBlended(query, 'apple', [cand(withVec, [1, 0, 0]), cand(noVec, null)], { now: 2_000 })
    // Both retrieved (both match keyword); the one WITH a matching vector wins
    // on the semantic term.
    expect(ranked.map((r) => r.memory.id)).toContain('vec')
    expect(ranked.map((r) => r.memory.id)).toContain('novec')
    expect(ranked[0].memory.id).toBe('vec')
  })

  it('treats a dim-mismatched vector as semantic 0 without throwing', () => {
    const query = [1, 0, 0] // dim 3
    const m = mem({ id: 'mm', title: 'banana', content: 'banana bread' })
    // Vector of WRONG dimensionality (2 vs 3) — scorer must guard.
    const ranked = scoreMemoriesBlended(query, 'banana', [cand(m, [1, 0])], { now: 2_000 })
    expect(ranked).toHaveLength(1)
    expect(ranked[0].semantic).toBe(0)
    expect(Number.isFinite(ranked[0].score)).toBe(true)
  })

  it('empty query vector → semantic collapses to 0 for all, no division blowup', () => {
    const a = mem({ id: 'a', title: 'x', content: 'x', updatedAt: 1_000 })
    const b = mem({ id: 'b', title: 'x', content: 'x', updatedAt: 9_000 })
    const ranked = scoreMemoriesBlended([], 'x', [cand(a, [1, 0, 0]), cand(b, [1, 0, 0])], { now: 10_000 })
    // No semantic signal → recency drives → newer first.
    expect(ranked[0].memory.id).toBe('b')
    for (const r of ranked) {
      expect(r.semantic).toBe(0)
      expect(Number.isFinite(r.score)).toBe(true)
    }
  })
})

// ── Weight normalization (raw scale doesn't auto-win) ─────────────

describe('weight normalization', () => {
  it('normalizes semantic across the set so a large raw cosine does not dominate absolutely', () => {
    const query = [1, 0, 0]
    // Two candidates: one perfect semantic match with weak keyword, one strong
    // keyword match with weak semantic. With 0.6/0.25 weights + normalization,
    // the semantic-perfect one should win, but the keyword one must still
    // score meaningfully (> recency-only floor), proving keyword isn't crushed.
    const semHit = mem({ id: 'sem', title: 'zzz', content: 'zzz', updatedAt: 5_000 })
    const kwHit = mem({ id: 'kw', title: 'rocket', content: 'rocket rocket rocket launch', updatedAt: 5_000 })
    const ranked = scoreMemoriesBlended(query, 'rocket', [cand(semHit, [1, 0, 0]), cand(kwHit, [0, 1, 0])], { now: 5_000 })

    const sem = ranked.find((r) => r.memory.id === 'sem')!
    const kw = ranked.find((r) => r.memory.id === 'kw')!
    // semHit: semantic normalized to 1, keyword 0 → ~0.6 (+type boost).
    // kwHit:  semantic 0, keyword normalized to 1 → ~0.25 (+type boost) + recency.
    expect(sem.semantic).toBeCloseTo(1, 5)
    expect(kw.keyword).toBeCloseTo(1, 5)
    expect(sem.score).toBeGreaterThan(kw.score)
    // Keyword candidate still clears the retrieval floor (not crushed to ~0).
    expect(kw.score).toBeGreaterThan(KEYWORD_WEIGHT * 0.5)
  })

  it('single candidate gets a finite score (no NaN from empty-set max)', () => {
    const query = [1, 0, 0]
    const only = mem({ id: 'solo', title: 'solo', content: 'solo content here', updatedAt: 1_000 })
    const ranked = scoreMemoriesBlended(query, 'solo', [cand(only, [1, 0, 0])], { now: 1_000 })
    expect(ranked).toHaveLength(1)
    expect(Number.isFinite(ranked[0].score)).toBe(true)
    expect(ranked[0].score).toBeGreaterThan(0)
  })
})
