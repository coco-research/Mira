import { describe, it, expect } from 'vitest'
import { isValidEmail } from '../waitlist'

// ═══════════════════════════════════════════════════════════════
//  waitlist — email validation (the client-side gate before any POST)
// ═══════════════════════════════════════════════════════════════

describe('isValidEmail', () => {
  it('accepts normal addresses', () => {
    expect(isValidEmail('david@example.com')).toBe(true)
    expect(isValidEmail('a.b+tag@sub.domain.co')).toBe(true)
    expect(isValidEmail('  trimmed@example.com  ')).toBe(true) // trims before testing
  })

  it('rejects bogus input', () => {
    expect(isValidEmail('')).toBe(false)
    expect(isValidEmail('noatsign')).toBe(false)
    expect(isValidEmail('@nolocal.com')).toBe(false)
    expect(isValidEmail('no@domain')).toBe(false) // no dot in domain
    expect(isValidEmail('has space@x.com')).toBe(false)
    expect(isValidEmail('two@@at.com')).toBe(false)
  })
})
