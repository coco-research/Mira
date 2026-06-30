/**
 * Tool-output truncation for Small-Model Mode (Knob 3).
 *
 * Long tool responses measurably hurt small models: in IBM's LongFuncEval
 * (arXiv 2505.10570) a long tool output cost Granite-3.1-8B ~30% AST accuracy,
 * and the lost-in-the-middle effect means the MIDDLE of a long result is the
 * least-attended part anyway. So when a tool returns a wall of text (a big
 * file_read, a verbose build log), keep the HEAD and the TAIL — where the
 * signal usually lives — and drop the middle with a marker.
 *
 * Big-model behaviour is unchanged: callers only apply this when
 * settings.smallModelMode is on.
 */
export function truncateToolResult(text: string, maxChars = 1500): string {
  if (typeof text !== 'string') return text as unknown as string
  if (text.length <= maxChars) return text
  // Head-heavy split: the start of a result usually carries the most signal
  // (the top of a file, the first compiler error). Reserve ~1/3 for the tail
  // so a trailing summary / exit code / final error still survives.
  const headChars = Math.max(0, Math.floor(maxChars * 0.66))
  const tailChars = Math.max(0, maxChars - headChars)
  const head = text.slice(0, headChars)
  const tail = tailChars > 0 ? text.slice(text.length - tailChars) : ''
  const dropped = text.length - head.length - tail.length
  return `${head}\n\n…[truncated ${dropped} chars for small-model mode]…\n\n${tail}`
}
