import { describe, it, expect } from 'vitest'
import {
  parseGitStatus,
  renderGitStatus,
  parseGitLog,
  shellQuote,
  buildGitCommitCommand,
  buildGhPrCreateCommand,
} from '../git-tools'

describe('parseGitStatus', () => {
  it('reads branch + ahead/behind from porcelain v2 headers', () => {
    const raw = [
      '# branch.oid abc123',
      '# branch.head feature/foo',
      '# branch.upstream origin/feature/foo',
      '# branch.ab +3 -1',
    ].join('\n')
    const r = parseGitStatus(raw)
    expect(r.branch).toBe('feature/foo')
    expect(r.ahead).toBe(3)
    expect(r.behind).toBe(1)
    expect(r.entries).toEqual([])
    expect(r.clean).toBe(true)
  })

  it('reports detached HEAD as branch null', () => {
    const raw = '# branch.head (detached)\n'
    expect(parseGitStatus(raw).branch).toBeNull()
  })

  it('parses untracked files (??)', () => {
    const raw = '# branch.head main\n? src/new.ts\n? README.md\n'
    const r = parseGitStatus(raw)
    expect(r.entries).toHaveLength(2)
    expect(r.entries[0].path).toBe('src/new.ts')
    expect(r.entries[0].code).toBe('??')
    expect(r.entries[0].staged).toBe(false)
    expect(r.clean).toBe(false)
  })

  it('parses staged + unstaged modifications and detects staged flag', () => {
    const raw = [
      '# branch.head main',
      // Format: 1 XY <sub> <mH> <mI> <mW> <hH> <hI> <path>
      '1 M. N... 100644 100644 100644 abc def src/a.ts',
      '1 .M N... 100644 100644 100644 abc def src/b.ts',
    ].join('\n')
    const r = parseGitStatus(raw)
    expect(r.entries).toHaveLength(2)
    expect(r.entries[0].path).toBe('src/a.ts')
    expect(r.entries[0].staged).toBe(true)
    expect(r.entries[1].staged).toBe(false)
  })

  it('treats unmerged paths (u) as conflicts', () => {
    const raw = '# branch.head main\nu UU N... 100644 100644 100644 100644 a b c src/conflict.ts\n'
    const r = parseGitStatus(raw)
    expect(r.entries).toHaveLength(1)
    expect(r.entries[0].code).toBe('UU')
  })
})

describe('renderGitStatus', () => {
  it('reports a clean tree without bullet list noise', () => {
    const text = renderGitStatus({
      branch: 'main',
      ahead: 0,
      behind: 0,
      entries: [],
      clean: true,
    })
    expect(text).toMatch(/Working tree clean/)
  })

  it('lists per-file entries with their codes', () => {
    const text = renderGitStatus({
      branch: 'feat',
      ahead: 2,
      behind: 0,
      entries: [
        { code: '??', path: 'a', staged: false },
        { code: 'M.', path: 'b', staged: true },
      ],
      clean: false,
    })
    expect(text).toMatch(/On branch feat \(ahead 2, behind 0\)/)
    expect(text).toMatch(/\?\? a/)
    expect(text).toMatch(/M\. b/)
  })
})

describe('parseGitLog', () => {
  it('extracts {sha, subject} pairs', () => {
    const raw = ['a63ff74 E2E test pass — fix 6 UX bugs', '81587fa TEST-PLAN.md commit'].join('\n')
    const r = parseGitLog(raw)
    expect(r).toEqual([
      { sha: 'a63ff74', subject: 'E2E test pass — fix 6 UX bugs' },
      { sha: '81587fa', subject: 'TEST-PLAN.md commit' },
    ])
  })

  it('skips empty lines and malformed rows', () => {
    expect(parseGitLog('\n\nnot a commit\nabc1234 ok\n')).toEqual([
      { sha: 'abc1234', subject: 'ok' },
    ])
  })
})

describe('shellQuote', () => {
  it('wraps simple strings in single quotes', () => {
    expect(shellQuote('hello')).toBe(`'hello'`)
  })

  it('escapes embedded single quotes', () => {
    expect(shellQuote(`it's`)).toBe(`'it'\\''s'`)
  })

  it('keeps quoted variables literal', () => {
    expect(shellQuote('$(rm -rf /)')).toBe(`'$(rm -rf /)'`)
  })
})

describe('buildGitCommitCommand', () => {
  it('returns empty for missing/empty message', () => {
    expect(buildGitCommitCommand({ message: '' })).toBe('')
    expect(buildGitCommitCommand({ message: '   ' })).toBe('')
  })

  it('falls back to commit-only when no files given', () => {
    expect(buildGitCommitCommand({ message: 'msg' })).toBe(`git commit -m 'msg'`)
  })

  it('stages all when allTracked is set', () => {
    expect(buildGitCommitCommand({ message: 'msg', allTracked: true })).toBe(
      `git add -A && git commit -m 'msg'`,
    )
  })

  it('stages explicit files when provided', () => {
    expect(buildGitCommitCommand({ message: 'msg', files: ['a', 'b c'] })).toBe(
      `git add -- 'a' 'b c' && git commit -m 'msg'`,
    )
  })
})

describe('buildGhPrCreateCommand', () => {
  it('returns empty for missing title', () => {
    expect(buildGhPrCreateCommand({ title: '', body: '' })).toBe('')
  })

  it('builds the basic title+body invocation', () => {
    expect(buildGhPrCreateCommand({ title: 'T', body: 'B' })).toBe(
      `gh pr create --title 'T' --body 'B'`,
    )
  })

  it('appends --base when provided', () => {
    expect(buildGhPrCreateCommand({ title: 'T', body: 'B', base: 'main' })).toBe(
      `gh pr create --title 'T' --body 'B' --base 'main'`,
    )
  })

  it('quotes multi-line bodies safely', () => {
    expect(
      buildGhPrCreateCommand({ title: 'T', body: "line1\nline2 's quote" }),
    ).toMatch(/--body 'line1\nline2 '\\''s quote'/)
  })
})
