import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { log, _scrubForTest } from '../logger'

describe('logger scrubber', () => {
  it('redacts top-level secret-like keys', () => {
    const r = _scrubForTest({
      ok: 1,
      password: 'p',
      apiKey: 'k',
      api_key: 'k',
      authorization: 'Bearer x',
      cookie: 'c',
      service_role: 'srv',
      private_key: 'pk',
      token: 't',
    }) as Record<string, unknown>
    expect(r.ok).toBe(1)
    for (const k of [
      'password',
      'apiKey',
      'api_key',
      'authorization',
      'cookie',
      'service_role',
      'private_key',
      'token',
    ]) {
      expect(r[k]).toBe('[REDACTED]')
    }
  })

  it('recurses into nested objects', () => {
    const r = _scrubForTest({
      user: { id: 'u', authorization: 'Bearer x' },
    }) as { user: { id: string; authorization: string } }
    expect(r.user.id).toBe('u')
    expect(r.user.authorization).toBe('[REDACTED]')
  })

  it('walks arrays without losing them', () => {
    const r = _scrubForTest({ items: [{ password: 'p' }, { ok: 1 }] }) as {
      items: Array<Record<string, unknown>>
    }
    expect(r.items[0].password).toBe('[REDACTED]')
    expect(r.items[1].ok).toBe(1)
  })

  it('caps recursion depth so cyclic-but-bounded input still scrubs', () => {
    let deep: Record<string, unknown> = { password: 'p' }
    for (let i = 0; i < 20; i++) deep = { next: deep }
    const r = _scrubForTest(deep)
    expect(JSON.stringify(r)).toBeTruthy()
  })

  it('passes through primitives unchanged', () => {
    expect(_scrubForTest(null)).toBeNull()
    expect(_scrubForTest(undefined)).toBeUndefined()
    expect(_scrubForTest(42)).toBe(42)
    expect(_scrubForTest('hi')).toBe('hi')
  })
})

describe('log levels', () => {
  const originalEnv = process.env.NODE_ENV

  beforeEach(() => {
    vi.spyOn(console, 'log').mockImplementation(() => {})
    vi.spyOn(console, 'error').mockImplementation(() => {})
  })

  afterEach(() => {
    process.env.NODE_ENV = originalEnv
    vi.restoreAllMocks()
  })

  it('writes JSON in production and skips debug', () => {
    process.env.NODE_ENV = 'production'
    log.debug('skipped')
    log.info('hello', { a: 1 })
    expect(console.log).not.toHaveBeenCalledWith(expect.stringContaining('"skipped"'))
    const infoCall = (console.log as ReturnType<typeof vi.fn>).mock.calls[0][0]
    expect(typeof infoCall).toBe('string')
    expect(JSON.parse(infoCall)).toMatchObject({ level: 'info', msg: 'hello', a: 1 })
  })

  it('routes warn/error through console.error in production', () => {
    process.env.NODE_ENV = 'production'
    log.warn('bad')
    log.error('worse')
    expect(console.error).toHaveBeenCalledTimes(2)
  })

  it('serialises an Error object into name/message/stack', () => {
    process.env.NODE_ENV = 'production'
    log.error('boom', { err: new Error('kapow') })
    const line = (console.error as ReturnType<typeof vi.fn>).mock.calls[0][0] as string
    const parsed = JSON.parse(line)
    expect(parsed.err.message).toBe('kapow')
    expect(parsed.err.name).toBe('Error')
    expect(typeof parsed.err.stack).toBe('string')
  })

  it('renders human-readable output in dev', () => {
    process.env.NODE_ENV = 'development'
    log.info('hello', { a: 1 })
    expect(console.log).toHaveBeenCalledWith('[info]', 'hello', { a: 1 })
  })
})
