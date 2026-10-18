import { bench, describe } from 'vitest'
import { BlockRuleMatcher } from './matcher'

/**
 * Lookup-budget sanity checks. The spec target is sub-100ns per lookup for
 * millions of rules, which is far beyond a JS Set/regex scan. These benches
 * keep the matcher within a sane envelope so regressions (accidental
 * quadratic scans, regex ReDoS, etc.) are caught early.
 */

describe('BlockRuleMatcher', () => {
  const RULE_COUNT = 50_000
  const exactRules: string[] = []
  const wildcardRules: string[] = []
  const hits: string[] = []
  const misses: string[] = []

  for (let index = 0; index < RULE_COUNT; index += 1) {
    exactRules.push(`exact-${index}.example.com`)
    wildcardRules.push(`*.wild-${index}.example.com`)
    hits.push(`exact-${index}.example.com`)
    misses.push(`sibling-${index}.other.example`)
  }

  const matcher = new BlockRuleMatcher({
    exact: exactRules,
    wildcards: wildcardRules,
    regexes: [],
    keywords: ['track'],
    exceptions: { exact: [], wildcards: [], keywords: [] },
  })

  bench('50k exact + 50k wildcard rules, half hits half misses', () => {
    for (let index = 0; index < RULE_COUNT; index += 1) {
      matcher.isBlocked(hits[index]!)
      matcher.isBlocked(misses[index]!)
    }
  }, { time: 500, iterations: 5 })

  const smallMatcher = new BlockRuleMatcher({
    exact: ['example.com'],
    wildcards: ['*.cdn.example.com'],
    regexes: ['^ad\\d{2}\\..*'],
    keywords: ['tracker'],
    exceptions: { exact: ['allow.example.com'], wildcards: [], keywords: [] },
  })

  bench('small rule set, per-query single lookups', () => {
    for (let index = 0; index < 10_000; index += 1) {
      smallMatcher.isBlocked(index % 2 === 0 ? 'example.com' : 'clean-site.org')
    }
  }, { time: 300, iterations: 15 })

  bench('exception-first precedence never falls through on allowed hosts', () => {
    for (let index = 0; index < 10_000; index += 1) {
      smallMatcher.isBlocked('allow.example.com')
    }
  }, { time: 300, iterations: 15 })
})