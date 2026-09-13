export type BlockRuleKind = 'exact' | 'wildcard' | 'regex' | 'keyword' | 'exception' | 'none'

export interface ExceptionPatterns {
  exact: string[]
  wildcards: string[]
  keywords: string[]
}

export interface RulePatterns {
  exact: string[]
  wildcards: string[]
  regexes: string[]
  keywords: string[]
  exceptions: ExceptionPatterns
}

export interface BlockVerdict {
  blocked: boolean
  rule: BlockRuleKind
}

/** Normalizes a domain for matching: trim, lowercase, strip trailing dots. */
export function normalizeDomain(domain: string): string {
  return domain.trim().toLowerCase().replace(/\.+$/, '')
}

/** True when `name` is equal to or a subdomain of `domain`. */
export function isSubdomainOf(name: string, domain: string): boolean {
  return name === domain || name.endsWith(`.${domain}`)
}

interface PatternInput {
  exact?: string[]
  wildcards?: string[]
  regexes?: string[]
  keywords?: string[]
}

/**
 * A set of matching patterns evaluated in a fixed precedence order:
 * exact → wildcard → regex → keyword (as required by the spec).
 */
class Patterns {
  readonly exact = new Set<string>()
  readonly wildcards: string[] = []
  readonly regexes: RegExp[] = []
  readonly keywords: string[] = []

  load(input: PatternInput): void {
    this.exact.clear()
    for (const entry of input.exact ?? []) {
      const domain = normalizeDomain(entry)
      if (domain !== '') {
        this.exact.add(domain)
      }
    }

    this.wildcards.length = 0
    for (const entry of input.wildcards ?? []) {
      const pattern = normalizeDomain(entry)
      if (pattern.startsWith('*.')) {
        this.wildcards.push(pattern)
      }
    }

    this.regexes.length = 0
    for (const entry of input.regexes ?? []) {
      try {
        this.regexes.push(new RegExp(entry, 'i'))
      } catch {
        // Ignore malformed rules rather than breaking DNS resolution.
      }
    }

    this.keywords.length = 0
    for (const entry of input.keywords ?? []) {
      const keyword = entry.toLowerCase()
      if (keyword !== '') {
        this.keywords.push(keyword)
      }
    }
  }

  match(name: string): BlockRuleKind | null {
    for (const domain of this.exact) {
      if (isSubdomainOf(name, domain)) {
        return 'exact'
      }
    }

    for (const wildcard of this.wildcards) {
      const base = wildcard.slice(2)
      if (isSubdomainOf(name, base)) {
        return 'wildcard'
      }
    }

    for (const regex of this.regexes) {
      if (regex.test(name)) {
        return 'regex'
      }
    }

    for (const keyword of this.keywords) {
      if (name.includes(keyword)) {
        return 'keyword'
      }
    }

    return null
  }
}

/**
 * Decides whether a DNS query name should be blocked. Exceptions are always
 * evaluated first: if an exception matches, the domain is allowed even when a
 * blocking rule also matches.
 */
export class BlockRuleMatcher {
  private readonly blocks = new Patterns()
  private readonly exceptions = new Patterns()

  constructor(patterns: RulePatterns = emptyPatterns()) {
    this.load(patterns)
  }

  load(patterns: RulePatterns): void {
    this.blocks.load(patterns)
    this.exceptions.load({
      exact: patterns.exceptions.exact,
      wildcards: patterns.exceptions.wildcards,
      keywords: patterns.exceptions.keywords,
    })
  }

  isBlocked(domain: string): BlockVerdict {
    const name = normalizeDomain(domain)
    if (this.exceptions.match(name) !== null) {
      return { blocked: false, rule: 'exception' }
    }

    const rule = this.blocks.match(name)
    return rule === null ? { blocked: false, rule: 'none' } : { blocked: true, rule }
  }
}

export function emptyPatterns(): RulePatterns {
  return {
    exact: [],
    wildcards: [],
    regexes: [],
    keywords: [],
    exceptions: { exact: [], wildcards: [], keywords: [] },
  }
}