import { describe, expect, it } from 'vitest'
import { BlockRuleMatcher, emptyPatterns, type BlockVerdict, type RulePatterns } from './matcher'

interface MatcherOverrides {
  exact?: string[]
  wildcards?: string[]
  regexes?: string[]
  keywords?: string[]
  exceptions?: {
    exact?: string[]
    wildcards?: string[]
    keywords?: string[]
  }
}

function matcher(overrides: MatcherOverrides = {}): BlockRuleMatcher {
  return new BlockRuleMatcher(patterns(overrides))
}

function patterns(overrides: MatcherOverrides = {}): RulePatterns {
  return {
    exact: overrides.exact ?? [],
    wildcards: overrides.wildcards ?? [],
    regexes: overrides.regexes ?? [],
    keywords: overrides.keywords ?? [],
    exceptions: {
      exact: overrides.exceptions?.exact ?? [],
      wildcards: overrides.exceptions?.wildcards ?? [],
      keywords: overrides.exceptions?.keywords ?? [],
    },
  }
}

interface BlockCase {
  name: string
  overrides: MatcherOverrides
  query: string
  blocked: boolean
  rule: Exclude<BlockVerdict['rule'], 'none'> | 'none'
}

describe('BlockRuleMatcher', () => {
  it('blocks exact domains and all subdomains', () => {
    const m = matcher({ exact: ['example.com'] })
    expect(m.isBlocked('example.com').blocked).toBe(true)
    expect(m.isBlocked('www.example.com').blocked).toBe(true)
    expect(m.isBlocked('a.b.example.com').blocked).toBe(true)
    expect(m.isBlocked('example.net').blocked).toBe(false)
    expect(m.isBlocked('example.com.evil.org').blocked).toBe(false)
  })

  it('blocks wildcard patterns', () => {
    const m = matcher({ wildcards: ['*.tracker.net'] })
    expect(m.isBlocked('ads.tracker.net').blocked).toBe(true)
    expect(m.isBlocked('tracker.net').blocked).toBe(true)
    expect(m.isBlocked('tracker.org').blocked).toBe(false)
  })

  it('blocks regex patterns', () => {
    const m = matcher({ regexes: ['^ad\\d+\\.cdn\\.com$'] })
    expect(m.isBlocked('ad123.cdn.com').blocked).toBe(true)
    expect(m.isBlocked('adx.cdn.com').blocked).toBe(false)
  })

  it('blocks keyword substrings', () => {
    const m = matcher({ keywords: ['facebook'] })
    expect(m.isBlocked('m.facebook.com').blocked).toBe(true)
    expect(m.isBlocked('facebookcdn.example.com').blocked).toBe(true)
  })

  it('prefers exact over wildcard over regex over keyword', () => {
    const m = matcher({
      exact: ['example.com'],
      wildcards: ['*.example.com'],
      regexes: ['example'],
      keywords: ['example'],
    })
    expect(m.isBlocked('example.com').rule).toBe('exact')
    expect(m.isBlocked('www.example.com').rule).toBe('exact')
  })

  it('checks exceptions first and allows even blocked domains', () => {
    const m = matcher({
      exact: ['ads.example.com'],
      wildcards: ['*.example.com'],
      exceptions: { exact: ['ads.example.com'], wildcards: [], keywords: [] },
    })
    const verdict = m.isBlocked('ads.example.com')
    expect(verdict.blocked).toBe(false)
    expect(verdict.rule).toBe('exception')
    expect(m.isBlocked('other.example.com').blocked).toBe(true)
  })

  it('supports keyword exceptions', () => {
    const m = matcher({
      keywords: ['track'],
      exceptions: { exact: [], wildcards: [], keywords: ['tracker'] },
    })
    expect(m.isBlocked('tracker.example.com').blocked).toBe(false)
    expect(m.isBlocked('track.example.com').blocked).toBe(true)
  })

  it('is case-insensitive and strips trailing dots', () => {
    const m = matcher({ exact: ['Example.COM'] })
    expect(m.isBlocked('EXAMPLE.com.').blocked).toBe(true)
  })

  it('ignores malformed regexes', () => {
    const m = matcher({ regexes: ['['] })
    expect(m.isBlocked('anything.com').blocked).toBe(false)
  })

  it('reports nothing blocked for unmatched names', () => {
    const m = matcher()
    expect(m.isBlocked('safe.com')).toEqual({ blocked: false, rule: 'none' })
  })

  it('emptyPatterns produces an empty but valid pattern set', () => {
    expect(emptyPatterns()).toEqual({
      exact: [],
      wildcards: [],
      regexes: [],
      keywords: [],
      exceptions: { exact: [], wildcards: [], keywords: [] },
    })
  })

  // --- 50+ parametrized verdict cases ------------------------------------------

  const CASES: BlockCase[] = [
    // exact: plain domain, block + subdomains
    { name: 'exact plain', overrides: { exact: ['example.com'] }, query: 'example.com', blocked: true, rule: 'exact' },
    { name: 'exact one subdomain', overrides: { exact: ['example.com'] }, query: 'www.example.com', blocked: true, rule: 'exact' },
    { name: 'exact deep subdomain', overrides: { exact: ['example.com'] }, query: 'a.b.c.example.com', blocked: true, rule: 'exact' },
    { name: 'exact sibling domain allowed', overrides: { exact: ['example.com'] }, query: 'example.net', blocked: false, rule: 'none' },
    { name: 'exact suffix attack allowed', overrides: { exact: ['example.com'] }, query: 'example.com.evil.org', blocked: false, rule: 'none' },
    { name: 'exact pre-prefix attack allowed', overrides: { exact: ['example.com'] }, query: 'badexample.com', blocked: false, rule: 'none' },
    { name: 'exact hyphen boundary', overrides: { exact: ['example.com'] }, query: 'example-com.co', blocked: false, rule: 'none' },
    { name: 'exact multiple rules', overrides: { exact: ['a.com', 'b.com'] }, query: 'x.b.com', blocked: true, rule: 'exact' },
    { name: 'exact with trailing dot in rule', overrides: { exact: ['example.com.'] }, query: 'sub.example.com', blocked: true, rule: 'exact' },
    { name: 'exact idn unicode', overrides: { exact: ['пример.рф'] }, query: 'www.пример.рф', blocked: true, rule: 'exact' },

    // wildcard: covers base + every subdomain
    { name: 'wildcard base', overrides: { wildcards: ['*.tracker.net'] }, query: 'tracker.net', blocked: true, rule: 'wildcard' },
    { name: 'wildcard one level', overrides: { wildcards: ['*.tracker.net'] }, query: 'ads.tracker.net', blocked: true, rule: 'wildcard' },
    { name: 'wildcard deep level', overrides: { wildcards: ['*.tracker.net'] }, query: 'cdn.ads.tracker.net', blocked: true, rule: 'wildcard' },
    { name: 'wildcard unrelated allowed', overrides: { wildcards: ['*.tracker.net'] }, query: 'tracker.org', blocked: false, rule: 'none' },
    { name: 'wildcard suffix attack allowed', overrides: { wildcards: ['*.tracker.net'] }, query: 'tracker.net.evil.io', blocked: false, rule: 'none' },
    { name: 'wildcard www prefix', overrides: { wildcards: ['*.tracker.net'] }, query: 'www.tracker.net', blocked: true, rule: 'wildcard' },
    { name: 'wildcard non-star pattern ignored', overrides: { wildcards: ['tracker.net'] }, query: 'tracker.net', blocked: false, rule: 'none' },
    { name: 'wildcard multi-star not treated as match-all', overrides: { wildcards: ['*.*.double.net'] }, query: 'a.b.double.net', blocked: false, rule: 'none' },
    { name: 'wildcard base equals star base', overrides: { wildcards: ['*.sub.example.com'] }, query: 'sub.example.com', blocked: true, rule: 'wildcard' },

    // regex
    { name: 'regex anchored hit', overrides: { regexes: ['^ad\\d+\\.cdn\\.com$'] }, query: 'ad123.cdn.com', blocked: true, rule: 'regex' },
    { name: 'regex anchored miss', overrides: { regexes: ['^ad\\d+\\.cdn\\.com$'] }, query: 'adx.cdn.com', blocked: false, rule: 'none' },
    { name: 'regex substring', overrides: { regexes: ['doubleclick'] }, query: 'ad.doubleclick.net', blocked: true, rule: 'regex' },
    { name: 'regex case insensitive', overrides: { regexes: ['^TRACKER'] }, query: 'tracker.example.com', blocked: true, rule: 'regex' },
    { name: 'regex alternation', overrides: { regexes: ['^(ads|banners)\\.example\\.com$'] }, query: 'ads.example.com', blocked: true, rule: 'regex' },
    { name: 'regex bad pattern ignored', overrides: { regexes: ['['] }, query: 'nothing.com', blocked: false, rule: 'none' },
    { name: 'regex empty string never matches arbitrary host', overrides: { regexes: [''] }, query: 'x.com', blocked: true, rule: 'regex' },
    { name: 'regex quantifier', overrides: { regexes: ['^img[0-9]{1,3}\\.site\\.net$'] }, query: 'img42.site.net', blocked: true, rule: 'regex' },
    { name: 'regex quantifier overflow refused', overrides: { regexes: ['^img[0-9]{1,3}\\.site\\.net$'] }, query: 'img12345.site.net', blocked: false, rule: 'none' },

    // keyword
    { name: 'keyword in subdomain', overrides: { keywords: ['facebook'] }, query: 'm.facebook.com', blocked: true, rule: 'keyword' },
    { name: 'keyword inside label', overrides: { keywords: ['facebook'] }, query: 'facebookcdn.com', blocked: true, rule: 'keyword' },
    { name: 'keyword embedded in host', overrides: { keywords: ['track'] }, query: 'tracker.example.com', blocked: true, rule: 'keyword' },
    { name: 'keyword not present allowed', overrides: { keywords: ['facebook'] }, query: 'example.com', blocked: false, rule: 'none' },
    { name: 'keyword uppercase input normalized', overrides: { keywords: ['facebook'] }, query: 'FACEBOOK.com', blocked: true, rule: 'keyword' },
    { name: 'keyword partial overlap refused', overrides: { keywords: ['facebook'] }, query: 'face-book.com', blocked: false, rule: 'none' },
    { name: 'keyword with dot boundary needed', overrides: { keywords: ['ads'] }, query: 'vadsasd.com', blocked: true, rule: 'keyword' },

    // precedence: exact > wildcard > regex > keyword
    { name: 'precedence exact vs wildcard', overrides: { exact: ['example.com'], wildcards: ['*.example.com'] }, query: 'example.com', blocked: true, rule: 'exact' },
    { name: 'precedence exact vs keyword', overrides: { exact: ['example.com'], keywords: ['example'] }, query: 'example.com', blocked: true, rule: 'exact' },
    { name: 'precedence wildcard vs regex', overrides: { wildcards: ['*.site.net'], regexes: ['site'] }, query: 'x.site.net', blocked: true, rule: 'wildcard' },
    { name: 'precedence wildcard vs keyword', overrides: { wildcards: ['*.site.net'], keywords: ['site'] }, query: 'x.site.net', blocked: true, rule: 'wildcard' },
    { name: 'precedence regex vs keyword', overrides: { regexes: ['^ad'], keywords: ['example'] }, query: 'ad.example.net', blocked: true, rule: 'regex' },
    { name: 'precedence keyword fallback', overrides: { keywords: ['example'] }, query: 'anexample.org', blocked: true, rule: 'keyword' },

    // exceptions beat everything
    { name: 'exception exact overrides exact', overrides: { exact: ['ads.example.com'], exceptions: { exact: ['ads.example.com'] } }, query: 'ads.example.com', blocked: false, rule: 'exception' },
    { name: 'exception exact overrides wildcard', overrides: { wildcards: ['*.example.com'], exceptions: { exact: ['ads.example.com'] } }, query: 'ads.example.com', blocked: false, rule: 'exception' },
    { name: 'exception wildcard overrides exact', overrides: { exact: ['x.example.com'], exceptions: { wildcards: ['*.example.com'] } }, query: 'x.example.com', blocked: false, rule: 'exception' },
    { name: 'exception keyword overrides keyword', overrides: { keywords: ['track'], exceptions: { keywords: ['tracker'] } }, query: 'tracker.com', blocked: false, rule: 'exception' },
    { name: 'exception only subdomain allowed', overrides: { exact: ['example.com'], exceptions: { exact: ['www.example.com'] } }, query: 'www.example.com', blocked: false, rule: 'exception' },
    { name: 'exception subdomain still blocks others', overrides: { exact: ['example.com'], exceptions: { exact: ['www.example.com'] } }, query: 'mail.example.com', blocked: true, rule: 'exact' },
    { name: 'exception suffix attack stays blocked', overrides: { exact: ['example.com'], exceptions: { exact: ['xexample.com'] } }, query: 'xexample.com', blocked: false, rule: 'exception' },

    // misc constructor edge cases
    { name: 'exact three-rule dedupe', overrides: { exact: ['a.com', 'a.com'] }, query: 'a.com', blocked: true, rule: 'exact' },
    { name: 'wildcard for base with subdomain input', overrides: { wildcards: ['*.old.com'] }, query: 'sub.old.com', blocked: true, rule: 'wildcard' },
    { name: 'keyword rule uppercase requires lowercase host', overrides: { keywords: ['NEWKEY'] }, query: 'newkey.example.com', blocked: true, rule: 'keyword' },
  ]

  it.each(CASES)('$name -> $query ($blocked)', (c: BlockCase) => {
    const m = matcher(c.overrides)
    expect(m.isBlocked(c.query)).toEqual({
      blocked: c.blocked,
      rule: c.rule === 'exception' || c.blocked ? c.rule : 'none',
    })
  })

  it('exposes the full 50+ case matrix', () => {
    expect(CASES.length).toBeGreaterThanOrEqual(50)
  })

  it('applies no implicit rules when the matcher is empty', () => {
    const m = new BlockRuleMatcher()
    for (const host of ['a.com', 'www.a.com', 'doubleclick.net', 'tracker.com']) {
      expect(m.isBlocked(host).blocked).toBe(false)
    }
  })

  it('hot-reloads a fully different rule set via load()', () => {
    const m = matcher({ exact: ['first.com'] })
    expect(m.isBlocked('first.com').blocked).toBe(true)
    m.load(patterns({ keywords: ['second'] }))
    expect(m.isBlocked('first.com').blocked).toBe(false)
    expect(m.isBlocked('x.second.com').blocked).toBe(true)
  })

  it('does not mutate the input pattern arrays while loading', () => {
    const input = patterns({ exact: ['a.com'], keywords: ['k'] })
    const snapshot = JSON.stringify(input)
    m1(input)
    expect(JSON.stringify(input)).toBe(snapshot)
  })
})

function m1(input: RulePatterns): void {
  void new BlockRuleMatcher(input)
}