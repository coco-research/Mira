// Bug Y/b (v2.5.0) — match an LM-Studio-installed model against a curated
// Discover entry's GGUF filename so the INSTALLED badge lights up after a
// restart. Pulled out of DiscoverModels.tsx so it can be unit-tested directly.
//
// Two id forms must be bridged:
//   • OLD / full:    "Qwen2.5-0.5B-Instruct-Q4_K_M.gguf" or "publisher/...-Q4_K_M"
//   • MODERN short:  "qwen2.5-0.5b-instruct@q4_k_m"  (LM Studio adds @quant only
//                    when several quants of the same model are downloaded)
//   • COLLAPSED:     "qwen/qwen2.5-vl-7b"  (publisher/repo, NO quant — what LM
//                    Studio reports when a model has a single quant on disk)
//
// CRITICAL correctness rule (v2.5.0 adversarial-audit fix): a Discover row is
// quant-SPECIFIC (its filename names exactly one quant), so the INSTALLED badge
// must only light when we have THAT quant. We therefore require quant equality
// whenever the Discover filename carries a quant. A COLLAPSED quant-less LM
// Studio id carries no quant evidence, so it deliberately does NOT light
// quant-specific rows — a false "you already have this" badge is worse than a
// missing one, and would otherwise wrongly mark every quant sibling of a model
// (e.g. all 7 "Qwen 3.6 27B" rows) as installed from a single download.

export interface InstalledModelLike {
  provider?: string
  providerName?: string
  model?: string
  name?: string
  lmsKey?: string
}

// Matches a trailing GGUF quant tag: optional `ud-` prefix, then
// q<n>… / iq<n>… / f16 / f32 / bf16, delimited by @ . _ or -.
const QUANT_TAIL = /[@._-]((?:ud-)?(?:iq\d|q\d|f16|f32|bf16)[a-z0-9_]*)$/i

/** The quant token of a model id/filename (compacted, e.g. "q4km"), or null. */
export function extractQuant(s: string): string | null {
  const base = (s.toLowerCase().split(/[\\/]/).pop() || '').replace(/\.gguf$/, '')
  const m = base.match(QUANT_TAIL)
  return m ? m[1].replace(/[^a-z0-9]/g, '') : null
}

/**
 * Model identity WITHOUT quant: last path segment, drop `.gguf`, drop the
 * trailing quant tag and one trailing decoration word (instruct/it/chat/hf),
 * then strip separators. Bridges "qwen/qwen2.5-vl-7b" and
 * "Qwen2.5-VL-7B-Instruct-Q4_K_M.gguf" → both "qwen25vl7b". Decoration words
 * like abliterated/uncensored/heretic are intentionally NOT stripped so
 * genuinely different finetunes never collapse together.
 */
export function modelIdentity(s: string): string {
  return (s.toLowerCase().split(/[\\/]/).pop() || '')
    .replace(/\.gguf$/, '')
    .replace(QUANT_TAIL, '')
    .replace(/[._-](instruct|it|chat|hf)$/i, '')
    .replace(/[^a-z0-9]/g, '')
}

/**
 * True when any LM-Studio-installed model corresponds to the given GGUF
 * filename. Order: exact basename / `publisher/`-suffix (already quant-precise),
 * then a normalised model-identity match that additionally REQUIRES the quant to
 * agree whenever the Discover filename names one.
 */
export function matchesLmStudioInstalled(
  filename: string,
  installed: InstalledModelLike[],
): boolean {
  if (!filename) return false
  const wantBase = filename.toLowerCase().replace(/\.gguf$/, '')
  const wantId = modelIdentity(filename)
  const wantQuant = extractQuant(filename)
  const lms = installed.filter((m) => {
    if (m.provider !== 'openai') return false
    const pname = (m.providerName || '').toLowerCase()
    return pname.includes('lm studio') || pname.includes('lmstudio')
  })
  for (const m of lms) {
    const candidates = [m.model, m.name, m.lmsKey]
      .filter(Boolean)
      .map((s) => String(s).toLowerCase())
    for (const c of candidates) {
      const cBase = c.replace(/\.gguf$/, '')
      // (1) exact / path-suffix — full basename ids, already carry the quant
      if (cBase === wantBase || cBase.endsWith(`/${wantBase}`) || cBase.endsWith(`\\${wantBase}`)) {
        return true
      }
      // (2) normalised identity + quant agreement
      const cId = modelIdentity(c)
      if (cId && wantId && cId.length >= 5 && cId === wantId) {
        if (!wantQuant) return true // generic Discover entry (no quant) → match
        const cQuant = extractQuant(c)
        if (cQuant && cQuant === wantQuant) return true // exact quant present
        // quant-specific Discover row but candidate quant missing/different →
        // do NOT light (avoids quant-sibling false positives).
      }
    }
  }
  return false
}
