/**
 * CodeBlock / HtmlPreviewModal Tests
 *
 * Tests the HTML-snippet detector used by the Preview chip. Every
 * positive case must be something we'd safely render in a sandboxed
 * iframe; every negative case must NOT trigger Preview (otherwise
 * we'd render random JS/CSS as HTML, which is confusing).
 *
 * Run: npx vitest run src/components/chat/__tests__/CodeBlock.test.ts
 */
import { describe, it, expect } from 'vitest'
import { isHtmlSnippet } from '../CodeBlock'

describe('isHtmlSnippet', () => {
  describe('by language tag (fenced code block lang)', () => {
    it('detects html', () => {
      expect(isHtmlSnippet('<div>x</div>', 'html')).toBe(true)
    })
    it('detects htm', () => {
      expect(isHtmlSnippet('<p>hello</p>', 'htm')).toBe(true)
    })
    it('detects xhtml', () => {
      expect(isHtmlSnippet('<p/>', 'xhtml')).toBe(true)
    })
    it('detects svg', () => {
      expect(isHtmlSnippet('<svg></svg>', 'svg')).toBe(true)
    })
    it('is case-insensitive on language', () => {
      expect(isHtmlSnippet('<p>x</p>', 'HTML')).toBe(true)
      expect(isHtmlSnippet('<p>x</p>', 'Html')).toBe(true)
    })
    it('does NOT trigger on js/ts/python/css', () => {
      expect(isHtmlSnippet('const x = 1', 'js')).toBe(false)
      expect(isHtmlSnippet('const x: number = 1', 'ts')).toBe(false)
      expect(isHtmlSnippet('print(1)', 'python')).toBe(false)
      expect(isHtmlSnippet('body { color: red }', 'css')).toBe(false)
    })
  })

  describe('by content (no language tag)', () => {
    it('detects a full <!DOCTYPE html> document', () => {
      const code = '<!DOCTYPE html>\n<html><body>x</body></html>'
      expect(isHtmlSnippet(code)).toBe(true)
    })
    it('detects lowercased <!doctype html>', () => {
      const code = '<!doctype html>\n<html></html>'
      expect(isHtmlSnippet(code)).toBe(true)
    })
    it('detects a document starting with <html', () => {
      expect(isHtmlSnippet('<html><body>x</body></html>')).toBe(true)
    })
    it('detects <svg xmlns=...>', () => {
      const code = '<svg xmlns="http://www.w3.org/2000/svg"><circle r="5"/></svg>'
      expect(isHtmlSnippet(code)).toBe(true)
    })
    it('tolerates leading whitespace before the marker', () => {
      const code = '   \n  <!DOCTYPE html>\n<html></html>'
      expect(isHtmlSnippet(code)).toBe(true)
      const code2 = '\n\t<html></html>'
      expect(isHtmlSnippet(code2)).toBe(true)
    })
  })

  describe('negative cases', () => {
    it('empty string → false', () => {
      expect(isHtmlSnippet('')).toBe(false)
      expect(isHtmlSnippet('   \n  ')).toBe(false)
    })
    it('plain text → false', () => {
      expect(isHtmlSnippet('Hello world')).toBe(false)
    })
    it('SVG without xmlns → false (too fragile to auto-detect)', () => {
      // Bare <svg> without xmlns is technically valid but most code-block
      // dumps are just fragments → don't auto-preview.
      expect(isHtmlSnippet('<svg><circle r="5"/></svg>')).toBe(false)
    })
    it('fragment <div> without lang tag → false', () => {
      // This is on purpose: `<div>foo</div>` by itself could be anything
      // (JSX, Vue template, Angular, …). We only preview when we're sure.
      expect(isHtmlSnippet('<div>foo</div>')).toBe(false)
    })
    it('JSON that starts with < → false', () => {
      expect(isHtmlSnippet('<not-html>')).toBe(false)
    })
    it('JavaScript using document.createElement → false', () => {
      expect(isHtmlSnippet('document.createElement("div")')).toBe(false)
    })
    it('CSS selector starting with html → false (content does not start with <html)', () => {
      expect(isHtmlSnippet('html { margin: 0 }')).toBe(false)
    })
  })
})
