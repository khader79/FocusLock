import { describe, expect, it } from 'vitest'
import { isSubdomainOf, normalizeDomain } from './matcher'

describe('normalizeDomain', () => {
  it.each([
    ['example.com', 'example.com'],
    ['  example.com  ', 'example.com'],
    ['Example.COM', 'example.com'],
    ['EXAMPLE.com.', 'example.com'],
    ['example.com.', 'example.com'],
    ['example.com..', 'example.com'],
    ['example.com...', 'example.com'],
    ['www.example.com', 'www.example.com'],
    ['a.b.c.example.com', 'a.b.c.example.com'],
    ['', ''],
    ['   ', ''],
    ['.', ''],
    ['..', ''],
    ['exa_mple.com', 'exa_mple.com'],
    ['пример.рф', 'пример.рф'],
  ] as const)('normalizes %j to %j', (input, expected) => {
    expect(normalizeDomain(input)).toBe(expected)
  })

  it('keeps a single trailing-root input empty after stripping dots', () => {
    expect(normalizeDomain('.')).toBe('')
  })

  it('does not collapse internal whitespace', () => {
    expect(normalizeDomain('example.com evil.org')).toBe('example.com evil.org')
  })
})

describe('isSubdomainOf', () => {
  it('treats equality as a subdomain match', () => {
    expect(isSubdomainOf('example.com', 'example.com')).toBe(true)
  })

  it.each([
    ['www.example.com', 'example.com', true],
    ['a.b.example.com', 'example.com', true],
    ['a.b.example.com', 'b.example.com', true],
    ['example.com', 'example.com', true],
    ['example.net', 'example.com', false],
    ['example.com.evil.org', 'example.com', false],
    ['exampleco.com', 'example.com', false],
    ['xexample.com', 'example.com', false],
    ['example.comx', 'example.com', false],
    ['', 'example.com', false],
    ['example.com', '', false],
  ] as const)('%s vs %s -> %s', (name, domain, expected) => {
    expect(isSubdomainOf(name, domain)).toBe(expected)
  })

  it('requires a dot boundary, not a prefix boundary', () => {
    expect(isSubdomainOf('notexample.com', 'example.com')).toBe(false)
    expect(isSubdomainOf('example.com.evil', 'example.com')).toBe(false)
  })
})