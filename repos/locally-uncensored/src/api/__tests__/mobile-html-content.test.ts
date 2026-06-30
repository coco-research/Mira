/**
 * Validates the raw HTML/CSS/JS string embedded in
 * src-tauri/src/commands/remote.rs `mobile_landing()`. Catches regressions
 * where someone accidentally deletes a class, helper, or required marker.
 */
import { describe, it, expect, beforeAll } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

let html = ''

beforeAll(() => {
  const src = readFileSync(
    resolve(process.cwd(), 'src-tauri/src/commands/remote.rs'),
    'utf-8',
  )
  const m = src.match(/async fn mobile_landing\(\)[\s\S]*?Html\(r#"([\s\S]*?)"#\.to_string\(\)\)/)
  if (!m) throw new Error('Could not locate mobile_landing HTML block')
  html = m[1]
})

describe('mobile_landing HTML › structural markers', () => {
  it('is a full HTML document', () => {
    expect(html.startsWith('<!DOCTYPE html>')).toBe(true)
  })

  it('contains <html>, <head>, <body>, </html>', () => {
    expect(html).toContain('<html')
    expect(html).toContain('<head>')
    expect(html).toContain('<body>')
    expect(html).toContain('</html>')
  })

  it('includes mobile viewport meta', () => {
    expect(html).toMatch(/<meta name="viewport"[^>]+width=device-width/)
  })

  it('uses system font stack (no Google Fonts — Bug #5)', () => {
    expect(html).toContain('system-ui')
    // Specifically, NO third-party font URLs
    expect(html).not.toContain('fonts.googleapis.com')
    expect(html).not.toContain('fonts.gstatic.com')
  })

  it('inlines SVG icons instead of Material Symbols font (Bug #5)', () => {
    // Font file link is gone, but icon names still route through a local
    // SVG dispatcher named svgIcon().
    expect(html).not.toContain('Material+Symbols+Outlined')
    expect(html).toContain('svgIcon')
    expect(html).toContain('var ICONS =')
  })

  it('sets a restrictive Content-Security-Policy (Bug #6)', () => {
    expect(html).toContain('http-equiv="Content-Security-Policy"')
    expect(html).toContain("default-src 'self'")
    expect(html).toContain("frame-ancestors 'none'")
  })

  it('has black theme color for mobile chrome', () => {
    expect(html).toContain("content='#0e0e0e'")
  })
})

describe('mobile_landing HTML › LU branding assets', () => {
  it('references the white-transparent monogram path', () => {
    expect(html).toContain('/LU-monogram-white.png')
  })

  it('does NOT reference the old bw monogram (should have been migrated)', () => {
    expect(html).not.toContain('/LU-monogram-bw.png')
  })

  it('uses the monogram in at least 4 places (auth, header, drawer, welcome)', () => {
    const matches = html.match(/\/LU-monogram-white\.png/g) || []
    expect(matches.length).toBeGreaterThanOrEqual(4)
  })

  it('has LUncensored wordmark', () => {
    expect(html).toContain('LUncensored')
  })
})

describe('mobile_landing HTML › feature markers', () => {
  it('hamburger drawer classes present', () => {
    expect(html).toContain('.drawer{')
    expect(html).toContain('.drawer-backdrop')
  })

  it('has _toggleDrawer handler', () => {
    expect(html).toContain('_toggleDrawer')
  })

  it('has _newChat handler for Chat + Codex', () => {
    expect(html).toContain('_newChat')
    expect(html).toContain("'codex'")
    expect(html).toContain("'lu'")
  })

  it('exposes _openModelPicker and _openPluginsPicker', () => {
    expect(html).toContain('_openModelPicker')
    expect(html).toContain('_openPluginsPicker')
  })

  it('has _toggleThinking handler', () => {
    expect(html).toContain('_toggleThinking')
  })

  it('has _triggerAttach + _removeImage for file attach', () => {
    expect(html).toContain('_triggerAttach')
    expect(html).toContain('_removeImage')
  })

  it('file input accepts image/* and multiple files', () => {
    expect(html).toMatch(/file-input[^>]*accept="image\/\*"[^>]*multiple/)
  })

  it('has _setCaveman + _setPersona handlers', () => {
    expect(html).toContain('_setCaveman')
    expect(html).toContain('_setPersona')
  })

  it('has _loadChat and _deleteChat handlers', () => {
    expect(html).toContain('_loadChat')
    expect(html).toContain('_deleteChat')
  })

  it('has _disconnect handler', () => {
    expect(html).toContain('_disconnect')
  })
})

describe('mobile_landing HTML › caveman/persona/codex content', () => {
  it('embeds all three CAVEMAN_PROMPTS', () => {
    expect(html).toContain('Be concise and direct')
    expect(html).toContain('Respond terse like smart caveman')
    expect(html).toContain('Maximum brevity')
  })

  it('embeds all three CAVEMAN_REMINDERS', () => {
    expect(html).toContain('[Be concise. No filler.]')
    expect(html).toContain('[Terse. Fragments OK. No fluff.]')
    expect(html).toContain('[Max brevity. Telegraphic.]')
  })

  it('has codex prompt snippet', () => {
    expect(html).toContain('You are the Coding Agent')
  })

  it('embeds the No Filter default persona', () => {
    expect(html).toContain("id:'unrestricted'")
  })

  it('embeds Code Expert persona', () => {
    expect(html).toContain("id:'coder'")
    expect(html).toContain('Code Expert')
  })

  it('embeds at least 20 personas (we ship 25)', () => {
    const matches = html.match(/\{id:'[^']+',name:'[^']+',prompt:/g) || []
    expect(matches.length).toBeGreaterThanOrEqual(20)
  })

  it('THINKING_COMPATIBLE list matches desktop (qwq/deepseek-r1/qwen3/gemma3/gemma4)', () => {
    expect(html).toContain("'qwq'")
    expect(html).toContain("'deepseek-r1'")
    expect(html).toContain("'qwen3'")
    expect(html).toContain("'gemma3'")
    expect(html).toContain("'gemma4'")
  })
})

describe('mobile_landing HTML › input bar sizing parity', () => {
  it('textarea min-height 44px matches attach/send button height', () => {
    // parity with user request: all three elements same height
    expect(html).toMatch(/min-height:44px/)
  })

  it('attach + send buttons are 44x44', () => {
    expect(html).toMatch(/\.attach-btn,\.send-btn\{width:44px;height:44px/)
  })
})

describe('mobile_landing HTML › plugins picker structure', () => {
  it('plugin sub-folder rows are collapsed by default via pluginsOpen reset', () => {
    expect(html).toMatch(/pluginsOpen\s*=\s*\{caveman:false,\s*persona:false\}/)
  })

  it('persona has on/off switch element', () => {
    expect(html).toContain('data-persona-enabled')
    expect(html).toContain('plug-switch')
  })

  it('picker sheet has a Plugins title', () => {
    expect(html).toContain('>Plugins<')
  })
})

describe('mobile_landing HTML › security/UX details', () => {
  it('auth screen uses numeric input for passcode', () => {
    expect(html).toMatch(/inputmode="numeric"/)
    expect(html).toMatch(/maxlength="6"/)
  })

  it('401 handler clears token + reloads', () => {
    expect(html).toContain('clearAuthAndReload')
  })

  it('Bearer token attached to authenticated fetches', () => {
    expect(html).toContain("'Authorization':'Bearer '+TOKEN")
  })

  it('chat-event endpoint posts mirror to desktop', () => {
    expect(html).toContain('/remote-api/chat-event')
  })

  it('streaming chat endpoint is /api/chat (Ollama proxy)', () => {
    expect(html).toContain("fetch('/api/chat'")
  })
})
