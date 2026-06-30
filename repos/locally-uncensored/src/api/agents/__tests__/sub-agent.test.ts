import { describe, it, expect, beforeEach, vi } from 'vitest'
import {
  DELEGATE_TASK_TOOL_DEF,
  SUB_AGENT_MAX_PARALLEL,
  SUB_AGENT_BUDGET,
  buildDelegateExecutor,
  _getDepth,
  _setDepth,
} from '../sub-agent'

describe('sub-agent — tool definition', () => {
  it('has the expected shape', () => {
    expect(DELEGATE_TASK_TOOL_DEF.name).toBe('delegate_task')
    expect(DELEGATE_TASK_TOOL_DEF.category).toBe('workflow')
    expect(DELEGATE_TASK_TOOL_DEF.source).toBe('builtin')
    expect(DELEGATE_TASK_TOOL_DEF.inputSchema.required).toContain('goal')
  })

  it('description contains the recursion + parallel hints', () => {
    expect(DELEGATE_TASK_TOOL_DEF.description).toMatch(/recursion is filtered/i)
    expect(DELEGATE_TASK_TOOL_DEF.description).toMatch(/PARALLELIZE/i)
  })
})

describe('sub-agent — buildDelegateExecutor', () => {
  beforeEach(() => {
    _setDepth(0)
  })

  it('rejects calls without a goal argument', async () => {
    const exec = buildDelegateExecutor(async () => 'unreachable')
    const out = await exec({})
    expect(out).toMatch(/requires a "goal" argument/i)
  })

  it('rejects whitespace-only goal', async () => {
    const exec = buildDelegateExecutor(async () => 'unreachable')
    const out = await exec({ goal: '   ' })
    expect(out).toMatch(/requires a "goal" argument/i)
  })

  it('invokes runner with trimmed goal + context + fresh budget', async () => {
    const runner = vi.fn(async (goal: string, context: string, { budget }: any) => {
      expect(goal).toBe('do the thing')
      expect(context).toBe('background notes')
      expect(budget.snapshot()).toEqual({
        toolCalls: 0,
        iterations: 0,
        caps: { ...SUB_AGENT_BUDGET },
      })
      return 'final answer'
    })
    const exec = buildDelegateExecutor(runner)
    const out = await exec({ goal: '  do the thing  ', context: '  background notes  ' })
    expect(out).toBe('final answer')
    expect(runner).toHaveBeenCalledOnce()
  })

  it('depth resets after a successful run', async () => {
    const runner = vi.fn(async () => 'ok')
    const exec = buildDelegateExecutor(runner)
    await exec({ goal: 'x' })
    expect(_getDepth()).toBe(0)
  })

  it('depth resets even when runner throws', async () => {
    const runner = vi.fn(async () => {
      throw new Error('boom')
    })
    const exec = buildDelegateExecutor(runner)
    const out = await exec({ goal: 'x' })
    expect(out).toMatch(/Error: boom/)
    expect(_getDepth()).toBe(0)
  })

  it('refuses once MAX_PARALLEL in-flight is reached', async () => {
    _setDepth(SUB_AGENT_MAX_PARALLEL)
    const runner = vi.fn(async () => 'should not run')
    const exec = buildDelegateExecutor(runner)
    const out = await exec({ goal: 'x' })
    expect(out).toMatch(/Maximum sub-agent concurrency/)
    expect(runner).not.toHaveBeenCalled()
    // And the tracker is not nudged by a refused call.
    expect(_getDepth()).toBe(SUB_AGENT_MAX_PARALLEL)
  })

  it('allows a call at MAX_PARALLEL - 1 (boundary)', async () => {
    _setDepth(SUB_AGENT_MAX_PARALLEL - 1)
    const runner = vi.fn(async () => 'ok')
    const exec = buildDelegateExecutor(runner)
    const out = await exec({ goal: 'x' })
    expect(out).toBe('ok')
    expect(_getDepth()).toBe(SUB_AGENT_MAX_PARALLEL - 1)
  })

  // ── Parallel siblings (Bonus, 2026-05) ─────────────────────────

  it('runs three parallel siblings concurrently — no false refusals', async () => {
    let observedMax = 0
    const starts: number[] = []
    const runner = async (goal: string) => {
      starts.push(Date.now())
      observedMax = Math.max(observedMax, _getDepth())
      await new Promise((r) => setTimeout(r, 10))
      return `done:${goal}`
    }
    const exec = buildDelegateExecutor(runner)
    const out = await Promise.all([
      exec({ goal: 'a' }),
      exec({ goal: 'b' }),
      exec({ goal: 'c' }),
    ])
    expect(out).toEqual(['done:a', 'done:b', 'done:c'])
    // All three should be in flight at the same time → observedMax = 3.
    expect(observedMax).toBe(3)
    // And every refusal would have been "should not run" — none returned.
    expect(out.every((s) => !s.startsWith('Error'))).toBe(true)
  })

  it('a 5th parallel sibling is refused (cap is 4)', async () => {
    _setDepth(0)
    const runner = vi.fn(async () => {
      await new Promise((r) => setTimeout(r, 20))
      return 'ok'
    })
    const exec = buildDelegateExecutor(runner)
    const five = [
      exec({ goal: 'a' }),
      exec({ goal: 'b' }),
      exec({ goal: 'c' }),
      exec({ goal: 'd' }),
      exec({ goal: 'e' }),
    ]
    const settled = await Promise.all(five)
    const refused = settled.filter((s) => /Maximum sub-agent concurrency/.test(s))
    expect(refused).toHaveLength(1)
    expect(runner).toHaveBeenCalledTimes(4)
  })

  it('after a refusal, the next call succeeds once a slot frees', async () => {
    _setDepth(SUB_AGENT_MAX_PARALLEL)
    const runner = vi.fn(async () => 'ok')
    const exec = buildDelegateExecutor(runner)
    expect(await exec({ goal: 'x' })).toMatch(/Maximum sub-agent concurrency/)
    _setDepth(0)
    expect(await exec({ goal: 'x' })).toBe('ok')
  })
})
