import { readFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { readBlocklistFile, readCategoriesFile } from '../blocker-core'
import { readEnabledPresetDomains } from '../categories'
import { readCustomSites } from '../custom-sites-store'
import { normalizeDomain, type RulePatterns } from './matcher'

export interface DnsRulesFile {
  enabled?: boolean
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

export interface LoadDnsRulesOptions {
  blocklistPath: string
  categoriesPath: string
  rulesPath: string
}

export function defaultDnsRulesFile(): DnsRulesFile {
  return {
    enabled: true,
    exact: [],
    wildcards: [],
    regexes: [],
    keywords: [],
    exceptions: { exact: [], wildcards: [], keywords: [] },
  }
}

async function readRulesFile(filePath: string): Promise<DnsRulesFile> {
  try {
    const raw = await readFile(filePath, 'utf8')
    const parsed: unknown = JSON.parse(raw)
    if (typeof parsed !== 'object' || parsed === null) {
      return defaultDnsRulesFile()
    }
    const source = parsed as Partial<DnsRulesFile>
    return {
      ...defaultDnsRulesFile(),
      ...source,
      exceptions: { ...defaultDnsRulesFile().exceptions, ...(source.exceptions ?? {}) },
    }
  } catch {
    return defaultDnsRulesFile()
  }
}

/**
 * Builds the matcher rule set from the persisted blocklist (plain domains),
 * enabled category presets, and the optional dedicated DNS rule file
 * (wildcards, regexes, keywords and exceptions).
 */
export async function loadDnsRules(options: LoadDnsRulesOptions): Promise<RulePatterns> {
  // The legacy categories.json lives in the same userData dir that holds the
  // preset state + downloaded lists, so the presets base dir derives from it.
  const [explicitBlocklist, categories, presetDomains, rulesFile, customSites] = await Promise.all([
    readBlocklistFile(options.blocklistPath),
    readCategoriesFile(options.categoriesPath),
    readEnabledPresetDomains(dirname(options.categoriesPath)),
    readRulesFile(options.rulesPath),
    readCustomSites(dirname(options.categoriesPath)),
  ])

  const exact = new Set(explicitBlocklist.map(normalizeDomain).filter((domain) => domain !== ''))
  for (const category of Object.values(categories)) {
    if (!category.enabled) {
      continue
    }
    for (const domain of category.domains) {
      const normalized = normalizeDomain(domain)
      if (normalized !== '') {
        exact.add(normalized)
      }
    }
  }
  for (const domain of presetDomains) {
    const normalized = normalizeDomain(domain)
    if (normalized !== '') {
      exact.add(normalized)
    }
  }
  for (const domain of rulesFile.exact ?? []) {
    const normalized = normalizeDomain(domain)
    if (normalized !== '') {
      exact.add(normalized)
    }
  }

  // Custom sites: the bare + www domains become exact entries, the wildcard
  // variant becomes a wildcard rule (covers base + every subdomain).
  const wildcards = new Set(rulesFile.wildcards ?? [])
  for (const site of customSites) {
    for (const variant of site.variants) {
      if (variant.startsWith('*.')) {
        const normalized = normalizeDomain(variant)
        if (normalized !== '') {
          wildcards.add(normalized)
        }
      } else {
        const normalized = normalizeDomain(variant)
        if (normalized !== '') {
          exact.add(normalized)
        }
      }
    }
  }

  return {
    exact: [...exact],
    wildcards: [...wildcards],
    regexes: rulesFile.regexes ?? [],
    keywords: rulesFile.keywords ?? [],
    exceptions: {
      exact: rulesFile.exceptions?.exact ?? [],
      wildcards: rulesFile.exceptions?.wildcards ?? [],
      keywords: rulesFile.exceptions?.keywords ?? [],
    },
  }
}

/** Reads only the enable flag from the DNS rule file. */
export async function isDnsFilterEnabled(filePath: string): Promise<boolean> {
  const rules = await readRulesFile(filePath)
  return rules.enabled !== false
}