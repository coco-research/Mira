import { describe, it, expect } from 'vitest'
import { parsePrUrl, normalisePrJson, renderPrResume } from '../pr-resume'

describe('parsePrUrl', () => {
  it('accepts the canonical https form', () => {
    expect(parsePrUrl('https://github.com/anthropics/apps/pull/123')).toEqual({
      owner: 'anthropics',
      repo: 'apps',
      number: 123,
    })
  })

  it('accepts http and trailing slash variants', () => {
    expect(parsePrUrl('http://github.com/foo/bar/pull/1/')).toEqual({
      owner: 'foo',
      repo: 'bar',
      number: 1,
    })
  })

  it('accepts the /files tab suffix', () => {
    expect(parsePrUrl('https://github.com/foo/bar/pull/42/files')).toEqual({
      owner: 'foo',
      repo: 'bar',
      number: 42,
    })
  })

  it('strips query strings and fragments', () => {
    expect(parsePrUrl('https://github.com/foo/bar/pull/42?diff=split#R10')).toEqual({
      owner: 'foo',
      repo: 'bar',
      number: 42,
    })
  })

  it('rejects non-PR github URLs', () => {
    expect(parsePrUrl('https://github.com/foo/bar/issues/1')).toBeNull()
    expect(parsePrUrl('https://github.com/foo/bar')).toBeNull()
    expect(parsePrUrl('https://github.com/foo/bar/pull/')).toBeNull()
  })

  it('rejects non-numeric PR numbers', () => {
    expect(parsePrUrl('https://github.com/foo/bar/pull/abc')).toBeNull()
  })

  it('rejects unrelated URLs', () => {
    expect(parsePrUrl('https://gitlab.com/foo/bar/pull/1')).toBeNull()
    expect(parsePrUrl('not a url')).toBeNull()
    expect(parsePrUrl('')).toBeNull()
  })
})

describe('normalisePrJson', () => {
  it('coerces missing fields to safe defaults', () => {
    const out = normalisePrJson({}, 'https://github.com/x/y/pull/1')
    expect(out.title).toBe('')
    expect(out.body).toBe('')
    expect(out.state).toBe('UNKNOWN')
    expect(out.comments).toEqual([])
    expect(out.author).toBeUndefined()
  })

  it('passes through populated fields', () => {
    const out = normalisePrJson(
      {
        title: 'T',
        body: 'B',
        state: 'OPEN',
        headRefName: 'feat/x',
        baseRefName: 'main',
        author: { login: 'alice' },
        comments: [
          { author: { login: 'bob' }, body: 'looks good', createdAt: '2026-05-01' },
        ],
      },
      'https://github.com/x/y/pull/1',
    )
    expect(out.title).toBe('T')
    expect(out.state).toBe('OPEN')
    expect(out.author).toBe('alice')
    expect(out.comments).toEqual([
      { author: 'bob', body: 'looks good', createdAt: '2026-05-01' },
    ])
  })

  it('keeps only the last 12 comments', () => {
    const comments = Array.from({ length: 30 }, (_, i) => ({
      author: { login: `u${i}` },
      body: `c${i}`,
      createdAt: '',
    }))
    const out = normalisePrJson({ comments }, 'https://github.com/x/y/pull/1')
    expect(out.comments).toHaveLength(12)
    expect(out.comments[0].author).toBe('u18')
    expect(out.comments[11].author).toBe('u29')
  })

  it('truncates absurdly long bodies', () => {
    const big = 'x'.repeat(10_000)
    const out = normalisePrJson({ body: big }, 'https://github.com/x/y/pull/1')
    expect(out.body.length).toBeLessThan(big.length)
    expect(out.body).toMatch(/truncated/)
  })
})

describe('renderPrResume', () => {
  it('renders the header, title, description, comments, and diff', () => {
    const text = renderPrResume({
      url: 'https://github.com/x/y/pull/1',
      title: 'Add foo',
      body: 'fix the thing',
      state: 'OPEN',
      headRefName: 'feat/foo',
      baseRefName: 'main',
      author: 'alice',
      comments: [
        { author: 'bob', body: 'lgtm', createdAt: '2026-05-01' },
      ],
      diff: '--- a/x\n+++ b/x\n@@ -1 +1 @@\n-foo\n+bar\n',
    })
    expect(text).toMatch(/# PR https/)
    expect(text).toMatch(/OPEN/)
    expect(text).toMatch(/feat\/foo → main/)
    expect(text).toMatch(/@alice/)
    expect(text).toMatch(/Add foo/)
    expect(text).toMatch(/fix the thing/)
    expect(text).toMatch(/\*\*@bob\*\*/)
    expect(text).toMatch(/```diff/)
    expect(text).toMatch(/-foo\n\+bar/)
  })

  it('drops the comments + diff sections when both are empty', () => {
    const text = renderPrResume({
      url: 'https://github.com/x/y/pull/1',
      title: 'Add foo',
      body: '',
      state: 'OPEN',
      headRefName: 'b',
      baseRefName: 'main',
      comments: [],
      diff: '',
    })
    expect(text).not.toMatch(/Latest comments/)
    expect(text).not.toMatch(/```diff/)
  })

  it('truncates oversized diffs', () => {
    const big = 'x'.repeat(20_000)
    const text = renderPrResume({
      url: 'https://github.com/x/y/pull/1',
      title: '',
      body: '',
      state: 'OPEN',
      headRefName: 'b',
      baseRefName: 'main',
      comments: [],
      diff: big,
    })
    expect(text).toMatch(/truncated/)
  })
})
