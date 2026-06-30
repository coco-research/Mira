import { describe, it, expect } from 'vitest'
import {
  detectRunnerFromFiles,
  commandForRunner,
  parseVitest,
  parseCargo,
  parsePytest,
  parseForRunner,
  renderResult,
} from '../test-runner'

describe('detectRunnerFromFiles', () => {
  it('returns vitest when vitest.config.ts is present', () => {
    expect(detectRunnerFromFiles(['vitest.config.ts', 'package.json'])).toBe('vitest')
  })

  it('returns cargo for Cargo.toml', () => {
    expect(detectRunnerFromFiles(['Cargo.toml'])).toBe('cargo')
  })

  it('returns pytest for pyproject.toml', () => {
    expect(detectRunnerFromFiles(['pyproject.toml'])).toBe('pytest')
  })

  it('returns jest for jest.config.js', () => {
    expect(detectRunnerFromFiles(['jest.config.js'])).toBe('jest')
  })

  it('falls back to vitest when only package.json is around', () => {
    expect(detectRunnerFromFiles(['package.json'])).toBe('vitest')
  })

  it('returns unknown when nothing matches', () => {
    expect(detectRunnerFromFiles(['README.md', 'LICENSE'])).toBe('unknown')
  })

  it('is case-insensitive', () => {
    expect(detectRunnerFromFiles(['CARGO.TOML'])).toBe('cargo')
  })
})

describe('commandForRunner', () => {
  it('returns a runnable command for every known runner', () => {
    expect(commandForRunner('vitest')).toMatch(/vitest/)
    expect(commandForRunner('cargo')).toMatch(/cargo test/)
    expect(commandForRunner('pytest')).toMatch(/pytest/)
    expect(commandForRunner('jest')).toMatch(/jest/)
  })

  it('returns empty string for unknown', () => {
    expect(commandForRunner('unknown')).toBe('')
  })
})

describe('parseVitest', () => {
  it('extracts the green case', () => {
    const out = `
RUN  v4.1.6
 Test Files  10 passed (10)
      Tests  100 passed (100)
`
    const r = parseVitest(out)
    expect(r.passed).toBe(true)
    expect(r.passedCount).toBe(100)
    expect(r.failedCount).toBe(0)
    expect(r.total).toBe(100)
  })

  it('extracts failing test names from the verbose reporter', () => {
    const out = `
 Test Files  1 failed | 9 passed (10)
      Tests  2 failed | 98 passed (100)
 × src/foo.test.ts > module > some test 12ms
 ✗ src/bar.test.ts > module > other test
`
    const r = parseVitest(out)
    expect(r.passed).toBe(false)
    expect(r.passedCount).toBe(98)
    expect(r.failedCount).toBe(2)
    expect(r.failedTests).toHaveLength(2)
    expect(r.failedTests[0]).toContain('some test')
    expect(r.failedTests[1]).toContain('other test')
  })

  it('treats an empty run as not-passed', () => {
    const r = parseVitest('')
    expect(r.passed).toBe(false)
    expect(r.total).toBe(0)
  })
})

describe('parseCargo', () => {
  it('extracts the green case', () => {
    const out = `running 80 tests
test foo ... ok
test bar ... ok
test result: ok. 80 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out`
    const r = parseCargo(out)
    expect(r.passed).toBe(true)
    expect(r.passedCount).toBe(80)
    expect(r.failedCount).toBe(0)
  })

  it('extracts failures', () => {
    const out = `test foo ... ok
test bar ... FAILED
test baz ... FAILED
test result: FAILED. 1 passed; 2 failed; 0 ignored`
    const r = parseCargo(out)
    expect(r.passed).toBe(false)
    expect(r.passedCount).toBe(1)
    expect(r.failedCount).toBe(2)
    expect(r.failedTests).toEqual(['bar', 'baz'])
  })
})

describe('parsePytest', () => {
  it('green case', () => {
    const r = parsePytest('======= 12 passed in 0.42s =======')
    expect(r.passed).toBe(true)
    expect(r.passedCount).toBe(12)
    expect(r.failedCount).toBe(0)
  })

  it('extracts failures', () => {
    const out = `===== 1 failed, 11 passed in 0.42s =====
FAILED tests/test_foo.py::test_bar - AssertionError: nope`
    const r = parsePytest(out)
    expect(r.passed).toBe(false)
    expect(r.failedCount).toBe(1)
    expect(r.passedCount).toBe(11)
    expect(r.failedTests).toEqual(['tests/test_foo.py::test_bar'])
  })
})

describe('parseForRunner', () => {
  it('routes by runner name', () => {
    expect(parseForRunner('cargo', 'test result: ok. 1 passed; 0 failed;').runner).toBe('cargo')
    expect(parseForRunner('pytest', '1 passed in 0s').runner).toBe('pytest')
    expect(parseForRunner('vitest', 'Tests 1 passed (1)').runner).toBe('vitest')
    expect(parseForRunner('jest', 'Tests 1 passed (1)').runner).toBe('jest')
    expect(parseForRunner('unknown', 'whatever').runner).toBe('unknown')
  })
})

describe('renderResult', () => {
  it('renders a passing run as PASSED', () => {
    const text = renderResult({
      runner: 'vitest',
      passed: true,
      total: 100,
      passedCount: 100,
      failedCount: 0,
      failedTests: [],
      outputTail: 'Done.',
    })
    expect(text).toMatch(/^PASSED \(vitest\)/)
    expect(text).toMatch(/100\/100/)
  })

  it('renders a failing run with the failure list', () => {
    const text = renderResult({
      runner: 'cargo',
      passed: false,
      total: 3,
      passedCount: 1,
      failedCount: 2,
      failedTests: ['a', 'b'],
      outputTail: 'tail',
    })
    expect(text).toMatch(/FAILED \(cargo\)/)
    expect(text).toMatch(/- a/)
    expect(text).toMatch(/- b/)
    expect(text).toMatch(/tail/)
  })
})
