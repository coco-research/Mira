/**
 * Smoke tests for the Codex fallback final answer logic.
 *
 * When the model's last turn returns empty content (all work happened via
 * tool calls), useCodex.ts builds a summary from AgentBlock[] so the
 * assistant message bubble is never blank.
 *
 * v2.5.0-polish (David 2026-06-04): the fallback is now HONEST — it no longer
 * prints "Task completed" when the model fired a couple of tool calls that
 * errored and then went silent. It only claims a clean finish ("Done:") when
 * something actually succeeded AND nothing failed; reports "Partially done:"
 * on mixed success/failure; and admits it couldn't finish when nothing
 * succeeded.
 *
 * We test the identical fallback logic in isolation and add drift detection.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'fs'
import { fileURLToPath } from 'url'
import { dirname, join } from 'path'

// ── Mirror of the fallback logic from useCodex.ts ───────────────────────
interface MockBlock {
  phase: string
  toolCall?: { toolName: string; status: string }
}

function buildFallbackAnswer(blocks: MockBlock[]): string {
  const completed = blocks.filter(b => b.phase === 'tool_call' && b.toolCall?.status === 'completed')
  const failed = blocks.filter(b => b.phase === 'tool_call' && b.toolCall?.status === 'failed')
  const writes = completed.filter(b => b.toolCall?.toolName === 'file_write')
  const reads = completed.filter(b => b.toolCall?.toolName === 'file_read')

  const parts: string[] = []
  if (writes.length) parts.push(`${writes.length} file(s) written`)
  if (reads.length) parts.push(`${reads.length} file(s) read`)
  const otherCompleted = completed.length - writes.length - reads.length
  if (otherCompleted > 0) parts.push(`${otherCompleted} other operation(s) completed`)
  if (failed.length) parts.push(`${failed.length} operation(s) failed`)

  if (completed.length === 0) {
    return failed.length
      ? `I couldn't complete the task — ${failed.length} operation(s) failed and nothing succeeded. Check the tool errors above, then refine the instruction or try a stronger model.`
      : `I stopped without completing the task — the model ended its turn without doing any work. Try rephrasing the instruction, or turn Think off and resend.`
  }
  if (failed.length > 0) {
    return `Partially done: ${parts.join(', ')}. Some steps failed — see the errors above; the result may be incomplete.`
  }
  return parts.length > 0 ? `Done: ${parts.join(', ')}.` : 'Done.'
}

// ── Tests ───────────────────────────────────────────────────────────────

describe('Codex fallback final answer', () => {
  it('produces a clean "Done" summary for file_write operations', () => {
    const blocks: MockBlock[] = [
      { phase: 'tool_call', toolCall: { toolName: 'file_write', status: 'completed' } },
      { phase: 'tool_call', toolCall: { toolName: 'file_write', status: 'completed' } },
      { phase: 'tool_call', toolCall: { toolName: 'file_write', status: 'completed' } },
    ]
    expect(buildFallbackAnswer(blocks)).toBe('Done: 3 file(s) written.')
  })

  it('produces a clean "Done" summary for file_read operations', () => {
    const blocks: MockBlock[] = [
      { phase: 'tool_call', toolCall: { toolName: 'file_read', status: 'completed' } },
      { phase: 'tool_call', toolCall: { toolName: 'file_read', status: 'completed' } },
    ]
    expect(buildFallbackAnswer(blocks)).toBe('Done: 2 file(s) read.')
  })

  it('produces summary for mixed (all-success) operations', () => {
    const blocks: MockBlock[] = [
      { phase: 'tool_call', toolCall: { toolName: 'file_read', status: 'completed' } },
      { phase: 'tool_call', toolCall: { toolName: 'file_write', status: 'completed' } },
      { phase: 'tool_call', toolCall: { toolName: 'file_write', status: 'completed' } },
      { phase: 'tool_call', toolCall: { toolName: 'shell_execute', status: 'completed' } },
      { phase: 'tool_call', toolCall: { toolName: 'file_list', status: 'completed' } },
    ]
    const answer = buildFallbackAnswer(blocks)
    expect(answer.startsWith('Done:')).toBe(true)
    expect(answer).toContain('2 file(s) written')
    expect(answer).toContain('1 file(s) read')
    expect(answer).toContain('2 other operation(s) completed')
  })

  it('reports a PARTIAL outcome when some ops succeed and some fail', () => {
    const blocks: MockBlock[] = [
      { phase: 'tool_call', toolCall: { toolName: 'file_write', status: 'completed' } },
      { phase: 'tool_call', toolCall: { toolName: 'file_write', status: 'failed' } },
      { phase: 'tool_call', toolCall: { toolName: 'shell_execute', status: 'failed' } },
    ]
    const answer = buildFallbackAnswer(blocks)
    expect(answer.startsWith('Partially done:')).toBe(true)
    expect(answer).toContain('1 file(s) written')
    expect(answer).toContain('2 operation(s) failed')
    // The honest fix: never the bare "Task completed" claim on a failed run.
    expect(answer).not.toContain('Task completed')
  })

  it('admits it could not finish when NOTHING succeeded (the gemma4 false-success bug)', () => {
    // Repro of David 2026-06-04: 2x shell_execute that errored, then silence —
    // the old code said "Task completed". Now it must be honest.
    const blocks: MockBlock[] = [
      { phase: 'tool_call', toolCall: { toolName: 'shell_execute', status: 'failed' } },
      { phase: 'tool_call', toolCall: { toolName: 'shell_execute', status: 'failed' } },
    ]
    const answer = buildFallbackAnswer(blocks)
    expect(answer).toContain("couldn't complete the task")
    expect(answer).toContain('nothing succeeded')
    expect(answer).not.toContain('Task completed')
  })

  it('admits it did no work when there are no blocks at all', () => {
    const answer = buildFallbackAnswer([])
    expect(answer).toContain('stopped without completing the task')
    expect(answer).not.toContain('Task completed')
  })

  it('ignores non-tool_call phases', () => {
    const blocks: MockBlock[] = [
      { phase: 'thinking', toolCall: undefined },
      { phase: 'streaming', toolCall: undefined },
      { phase: 'tool_call', toolCall: { toolName: 'file_write', status: 'completed' } },
    ]
    expect(buildFallbackAnswer(blocks)).toBe('Done: 1 file(s) written.')
  })

  it('ignores running operations (not yet completed or failed)', () => {
    const blocks: MockBlock[] = [
      { phase: 'tool_call', toolCall: { toolName: 'file_write', status: 'completed' } },
      { phase: 'tool_call', toolCall: { toolName: 'shell_execute', status: 'running' } },
    ]
    // 'running' is neither 'completed' nor 'failed', so it's not counted
    expect(buildFallbackAnswer(blocks)).toBe('Done: 1 file(s) written.')
  })

  it('handles all-failed scenario honestly', () => {
    const blocks: MockBlock[] = [
      { phase: 'tool_call', toolCall: { toolName: 'file_write', status: 'failed' } },
      { phase: 'tool_call', toolCall: { toolName: 'file_write', status: 'failed' } },
    ]
    const answer = buildFallbackAnswer(blocks)
    expect(answer).toContain("couldn't complete the task")
    expect(answer).toContain('2 operation(s) failed')
  })

  it('handles large batch with diverse tools (partial — one failure)', () => {
    const blocks: MockBlock[] = [
      ...Array(5).fill(null).map(() => ({ phase: 'tool_call', toolCall: { toolName: 'file_write', status: 'completed' } })),
      ...Array(3).fill(null).map(() => ({ phase: 'tool_call', toolCall: { toolName: 'file_read', status: 'completed' } })),
      ...Array(2).fill(null).map(() => ({ phase: 'tool_call', toolCall: { toolName: 'shell_execute', status: 'completed' } })),
      { phase: 'tool_call', toolCall: { toolName: 'file_search', status: 'completed' } },
      { phase: 'tool_call', toolCall: { toolName: 'file_write', status: 'failed' } },
    ]
    const answer = buildFallbackAnswer(blocks)
    expect(answer.startsWith('Partially done:')).toBe(true)
    expect(answer).toContain('5 file(s) written')
    expect(answer).toContain('3 file(s) read')
    expect(answer).toContain('3 other operation(s) completed')
    expect(answer).toContain('1 operation(s) failed')
  })
})

// ── Drift detection ─────────────────────────────────────────────────────
describe('fallback answer drift detection', () => {
  it('useCodex.ts contains the honest fallback summary builder', () => {
    const __filename = fileURLToPath(import.meta.url)
    const __dirname = dirname(__filename)
    const src = readFileSync(join(__dirname, '../useCodex.ts'), 'utf8')

    // Must contain the fallback trigger
    expect(src).toContain('if (!fullContent.trim())')
    // Must build parts array with file write/read counts
    expect(src).toContain('file(s) written')
    expect(src).toContain('file(s) read')
    // Must use the honest wording, NOT the old false "Task completed:" claim.
    expect(src).toContain('Partially done:')
    expect(src).toContain("couldn't complete the task")
    expect(src).not.toContain('Task completed:')
  })
})
