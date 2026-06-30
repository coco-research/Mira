import { describe, it, expect } from 'vitest'
import { selectRelevantTools } from '../tool-selection'
import type { MCPToolDefinition, PermissionMap } from '../../api/mcp/types'
import { DEFAULT_PERMISSIONS } from '../../api/mcp/types'

// Minimal tool defs — names + categories are all selectRelevantTools needs.
const T = (name: string, category: MCPToolDefinition['category']): MCPToolDefinition => ({
  name,
  description: name,
  inputSchema: { type: 'object', properties: {}, required: [] },
  category,
  source: 'builtin',
})

const ALL: MCPToolDefinition[] = [
  T('web_search', 'web'),
  T('web_fetch', 'web'),
  T('file_read', 'filesystem'),
  T('file_write', 'filesystem'),
  T('file_list', 'filesystem'),
  T('file_search', 'filesystem'),
  T('shell_execute', 'terminal'),
  T('code_execute', 'terminal'),
  T('system_info', 'system'),
  T('get_current_time', 'system'),
  T('image_generate', 'image'),
  T('video_generate', 'video'),
]

const PERMS: PermissionMap = { ...DEFAULT_PERMISSIONS, video: 'auto' }

const names = (msg: string, perms: PermissionMap = PERMS) =>
  selectRelevantTools(msg, ALL, perms).map((t) => t.name)

describe('web search tool selection (Websearch im Chat)', () => {
  it('selects web tools for English search intents', () => {
    expect(names('search the web for the latest Tauri release')).toContain('web_search')
    expect(names('look up the weather in Berlin tomorrow')).toContain('web_search')
    expect(names('fetch https://example.com/changelog and summarize it')).toContain('web_fetch')
  })

  it('selects web tools for German search intents', () => {
    expect(names('such nach den neuesten ollama versionen')).toContain('web_search')
    expect(names('recherchiere bitte die aktuellen GPU preise')).toContain('web_search')
    expect(names('was sind die neuesten nachrichten zu rust?')).toContain('web_search')
    expect(names('wie ist das wetter morgen in hamburg')).toContain('web_search')
  })

  it('does NOT trigger on the English phrase "such as"', () => {
    // "such " as a keyword would match every "such as" sentence — pinned here
    // so nobody re-adds it.
    const sel = names('write a poem about animals such as cats and dogs')
    expect(sel).not.toContain('web_search')
  })

  it('web tools drop out when the web category is blocked', () => {
    const sel = names('search the web for rust news', { ...PERMS, web: 'blocked' })
    expect(sel).not.toContain('web_search')
    expect(sel).not.toContain('web_fetch')
  })

  it('generic short prompts include web_search as flexibility fallback', () => {
    // Existing behaviour (selectedNames.size <= 3 → add common tools) — pinned.
    expect(names('help me with this project')).toContain('web_search')
  })
})
