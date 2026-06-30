/**
 * LAN / private-host detection tests (Bug A / GH #49).
 *
 * The LAN OpenAI-compat "Test" button failed because a 192.168.x.x endpoint was
 * classified as cloud → direct webview fetch → CSP/CORS-blocked. These helpers
 * decide proxy-vs-direct routing, so their classification is the heart of the fix.
 * Run: npx vitest run src/api/__tests__/lan-host.test.ts
 */
import { describe, it, expect } from 'vitest'
import { isLoopbackHost, isPrivateOrLanHost, hostnameOf } from '../backend'

describe('isLoopbackHost', () => {
  it('detects loopback variants', () => {
    for (const h of ['localhost', '127.0.0.1', '::1', '0.0.0.0', 'foo.localhost'])
      expect(isLoopbackHost(h)).toBe(true)
  })
  it('rejects non-loopback hosts', () => {
    for (const h of ['192.168.1.50', 'api.openai.com', '10.0.0.1'])
      expect(isLoopbackHost(h)).toBe(false)
  })
})

describe('isPrivateOrLanHost (Bug A / #49)', () => {
  it('treats RFC1918 + CGNAT + loopback as LAN', () => {
    for (const h of ['127.0.0.1', 'localhost', '192.168.1.50', '10.0.0.5',
                     '172.16.0.1', '172.31.255.254', '100.64.0.1'])
      expect(isPrivateOrLanHost(h)).toBe(true)
  })
  it('treats LAN DNS suffixes + bare machine names as LAN', () => {
    for (const h of ['nas', 'mypc', 'server.local', 'box.lan', 'host.internal'])
      expect(isPrivateOrLanHost(h)).toBe(true)
  })
  it('treats IPv6 ULA + link-local as LAN', () => {
    for (const h of ['fd00::1', 'fc00::1', 'fe80::1', '[fd00::1]'])
      expect(isPrivateOrLanHost(h)).toBe(true)
  })
  it('treats public hosts + cloud APIs as NOT LAN', () => {
    for (const h of ['api.openai.com', 'openrouter.ai', '8.8.8.8', '1.1.1.1',
                     '2606:4700::1111'])
      expect(isPrivateOrLanHost(h)).toBe(false)
  })
  it('does NOT treat 169.254 link-local/metadata as LAN (proxy hard-blocks it)', () => {
    expect(isPrivateOrLanHost('169.254.169.254')).toBe(false)
    expect(isPrivateOrLanHost('169.254.0.1')).toBe(false)
  })
  it('rejects malformed octets', () => {
    expect(isPrivateOrLanHost('999.1.1.1')).toBe(false)
    expect(isPrivateOrLanHost('')).toBe(false)
  })
})

describe('hostnameOf', () => {
  it('extracts a lowercase host from a URL', () => {
    expect(hostnameOf('http://192.168.1.50:1234/v1')).toBe('192.168.1.50')
    expect(hostnameOf('https://API.OpenAI.com/v1')).toBe('api.openai.com')
    expect(hostnameOf('http://[fd00::1]:1234')).toBe('fd00::1')
  })
  it('returns empty for junk', () => {
    expect(hostnameOf('not a url')).toBe('')
  })
})
