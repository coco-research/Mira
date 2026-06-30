import { describe, it, expect } from 'vitest'
import {
  AGENT_COMMANDS,
  parseAgentCommand,
  matchAgentCommands,
} from '../agent-commands'

describe('AGENT_COMMANDS registry', () => {
  it('ships exactly the 10 named commands', () => {
    expect(AGENT_COMMANDS.map((c) => c.name).sort()).toEqual(
      ['commit', 'docs', 'explain', 'fix', 'init', 'optimize', 'refactor', 'review', 'security', 'test'].sort(),
    )
  })

  it('every command has a summary and a non-empty expansion', () => {
    for (const c of AGENT_COMMANDS) {
      expect(c.summary.length).toBeGreaterThan(5)
      expect(c.build('').length).toBeGreaterThan(40)
      expect(c.build('src/app.ts').length).toBeGreaterThan(40)
    }
  })

  it('command names are unique', () => {
    const names = AGENT_COMMANDS.map((c) => c.name)
    expect(new Set(names).size).toBe(names.length)
  })

  it('read-only commands never instruct file_write in their template', () => {
    for (const c of AGENT_COMMANDS.filter((c) => c.readOnly)) {
      expect(c.build('x').toLowerCase()).toContain('read-only')
      expect(c.build('x')).not.toMatch(/\bfile_write\b/)
    }
  })
})

describe('parseAgentCommand', () => {
  it('parses a bare command', () => {
    const r = parseAgentCommand('/init')
    expect(r?.command.name).toBe('init')
    expect(r?.args).toBe('')
    expect(r?.expanded).toContain('AGENTS.md')
  })

  it('parses a command with args and threads them into the expansion', () => {
    const r = parseAgentCommand('/explain src/hooks/useChat.ts')
    expect(r?.command.name).toBe('explain')
    expect(r?.args).toBe('src/hooks/useChat.ts')
    expect(r?.expanded).toContain('src/hooks/useChat.ts')
  })

  it('is case-insensitive on the command name', () => {
    expect(parseAgentCommand('/REVIEW changes')?.command.name).toBe('review')
  })

  it('handles multi-line / quoted args', () => {
    const r = parseAgentCommand('/fix TypeError: cannot read "x" of undefined\nat foo.ts:10')
    expect(r?.command.name).toBe('fix')
    expect(r?.expanded).toContain('TypeError')
  })

  it('returns null for unknown commands so they fall through to chat', () => {
    expect(parseAgentCommand('/notacommand do thing')).toBeNull()
    expect(parseAgentCommand('/')).toBeNull()
  })

  it('returns null for normal text and for a slash mid-sentence', () => {
    expect(parseAgentCommand('hello there')).toBeNull()
    expect(parseAgentCommand('what is 1/2 of 8')).toBeNull()
    expect(parseAgentCommand('please run the /review later')).toBeNull()
  })

  it('commit template forbids pushing', () => {
    expect(parseAgentCommand('/commit')?.expanded.toLowerCase()).toContain('do not push')
  })
})

describe('matchAgentCommands (autocomplete)', () => {
  it('returns all commands for a lone slash', () => {
    expect(matchAgentCommands('/').length).toBe(10)
  })

  it('prefix-filters by name', () => {
    expect(matchAgentCommands('/re').map((c) => c.name).sort()).toEqual(['refactor', 'review'])
    expect(matchAgentCommands('/sec').map((c) => c.name)).toEqual(['security'])
  })

  it('returns [] once the user has typed a space (now typing args, not picking)', () => {
    expect(matchAgentCommands('/review ')).toEqual([])
    expect(matchAgentCommands('/review changes')).toEqual([])
  })

  it('returns [] for a non-slash input', () => {
    expect(matchAgentCommands('review')).toEqual([])
    expect(matchAgentCommands('')).toEqual([])
  })

  it('returns [] for an unmatched prefix', () => {
    expect(matchAgentCommands('/zzz')).toEqual([])
  })
})
